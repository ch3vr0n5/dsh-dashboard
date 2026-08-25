/** Poll, reconcile, claim, dispatch, continue, retry, and observe normalized tasks. */

import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import type { ProjectCatalog } from '../catalog/catalog.ts'
import type { LifecycleSessionRecord, WorkerSessionRecord } from '../catalog/types.ts'
import type { TaskIssue } from '../domain/issue.ts'
import { hasRequiredLabels, issueKey, normalizedState } from '../domain/issue.ts'
import { AgentBlockedError, type AgentRunResult, type HarnessAgentRunner } from '../agent/harness-runner.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {
  BoardColumn,
  DashboardSnapshot,
  IssueDetailView,
  IssueRuntimeView,
  RuntimeEventView,
  TaskTimelineOptions,
  TaskTimelinePage,
  TokenTotals,
} from '../runtime/types.ts'
import { addTokens, emptyTokens } from '../runtime/types.ts'
import { buildTaskTimelinePage, RuntimeTimelineArchive } from '../runtime/timeline.ts'
import type { CreateTaskInput, TaskSourceResolver, UpdateTaskInput } from '../task-source/index.ts'
import type { WorkflowStore } from '../workflow/store.ts'
import type { WorkflowDefinition } from '../workflow/types.ts'
import type { WorkspaceManager } from '../workspace/manager.ts'
import { resolveWorkspaceRoot } from '../workspace/path-safety.ts'
import { compareCandidates, failureRetryDelay, stateLimit } from './scheduling.ts'
import { compactHandoff, DEFAULT_LIFECYCLE_POLICY, resolveLifecyclePipeline, rolePrompt } from '../lifecycle/policy.ts'
import type { LifecycleRole } from '../lifecycle/types.ts'

interface RunningRecord {
  issue: TaskIssue
  readonly workflow: WorkflowDefinition
  readonly abort: AbortController
  readonly attempt: number
  runtime: IssueRuntimeView
}

interface RetryRecord {
  readonly issue: TaskIssue
  readonly attempt: number
  readonly dueAt: number
  readonly error: string
  readonly runtime: IssueRuntimeView
}

export interface OrchestratorConfig {
  readonly projectId: string
  readonly agentProfile: string
  readonly permissionPreset: string
  readonly agentPreset?: string
  readonly workerHost: string
}

/** Long-lived service logic; every mutable operation is bounded to the caller plugin fiber. */
export class DashboardOrchestrator {
  private readonly running = new Map<string, RunningRecord>()
  private readonly retries = new Map<string, RetryRecord>()
  private readonly runtimeArchive = new Map<string, IssueRuntimeView>()
  /** Bounded in-process event logs; intentionally kept out of the polling snapshot. */
  private readonly timelineArchive = new Map<string, RuntimeTimelineArchive>()
  private timelineEventSequence = 0
  private board: readonly TaskIssue[] = []
  private paused = false
  private lastRefreshAt: string | undefined
  private nextRefreshAt: string | undefined
  private lastError: string | undefined
  private timer: NodeJS.Timeout | undefined
  private refreshing: Promise<void> | undefined
  private refreshingDispatchEnabled = false
  private stopped = false
  /** Preserves direct/manual refresh semantics before lifecycle scheduling starts. */
  private active = true
  private readonly manualStops = new Set<string>()
  private readonly terminalStops = new Set<string>()
  private readonly holds = new Map<string, { readonly issueRevision: string; readonly reason: string }>()

  constructor(
    private readonly ctx: Context,
    private readonly workflow: WorkflowStore,
    private readonly sources: TaskSourceResolver,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: HarnessAgentRunner,
    private readonly catalog: ProjectCatalog,
    private readonly config: OrchestratorConfig,
  ) {}

  /** Start polling immediately; caller owns the returned asynchronous disposer. */
  start(active = true): () => Promise<void> {
    this.stopped = false
    this.active = active
    const unsubscribe = this.workflow.subscribe(() => {
      if (this.active) this.schedule(0)
    })
    if (active) this.schedule(0)
    return async () => {
      this.stopped = true
      this.active = false
      unsubscribe()
      if (this.timer !== undefined) clearTimeout(this.timer)
      this.timer = undefined
      for (const record of this.running.values()) record.abort.abort(new Error('dsh-dashboard plugin disposed'))
      await Promise.allSettled([...this.running.values()].map(record => waitUntil(() => !this.running.has(issueKey(record.issue)))))
    }
  }

  /** Coalesced manual or timer refresh. */
  async refresh(): Promise<void> {
    if (this.stopped || !this.active) return
    if (this.refreshing !== undefined) {
      const dispatchEnabled = this.refreshingDispatchEnabled
      await this.refreshing
      if (!dispatchEnabled && !this.stopped && this.active) await this.refresh()
      return
    }
    const job = this.poll(true).finally(() => {
      if (this.refreshing === job) {
        this.refreshing = undefined
        this.refreshingDispatchEnabled = false
      }
      this.scheduleNext()
    })
    this.refreshingDispatchEnabled = true
    this.refreshing = job
    return await job
  }

  /** Refresh provider state for a composite view without dispatching new Agents. */
  async refreshOverview(): Promise<void> {
    if (this.stopped) return
    if (this.refreshing !== undefined) return await this.refreshing
    const job = this.poll(false).finally(() => {
      if (this.refreshing === job) {
        this.refreshing = undefined
        this.refreshingDispatchEnabled = false
      }
    })
    this.refreshingDispatchEnabled = false
    this.refreshing = job
    return await job
  }

  setPaused(paused: boolean): void {
    this.paused = paused
    if (!paused) this.schedule(0)
  }

  /** Activate or suspend polling without aborting Agents already owned by this project. */
  setActive(active: boolean): void {
    if (this.stopped || this.active === active) return
    this.active = active
    if (active) {
      this.schedule(0)
      return
    }
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.nextRefreshAt = undefined
  }

  runtimeActivity(): { readonly running: number; readonly retrying: number } {
    return { running: this.running.size, retrying: this.retries.size }
  }

  /** Current project-owned refresh cadence used by composite scheduling. */
  pollingIntervalMs(): number {
    try {
      return this.workflow.require().polling.interval_ms
    } catch {
      return 5_000
    }
  }

  stopIssue(key: string): boolean {
    const record = this.running.get(key)
    if (record === undefined) return false
    const currentIssue = this.board.find(issue => issueKey(issue) === key) ?? record.issue
    record.issue = currentIssue
    this.manualStops.add(key)
    void this.hold(currentIssue, 'Agent explicitly stopped from Dashboard').catch(error => {
      this.ctx.logger.warn('dsh-dashboard: failed to persist explicit stop for %s: %s', currentIssue.identifier, String(error))
    })
    record.abort.abort(new Error('agent stopped from Dashboard'))
    return true
  }

  async snapshot(): Promise<DashboardSnapshot> {
    const workflowStatus = this.workflow.status()
    const definition = workflowStatus.current
    const source = definition === undefined ? undefined : this.sources.require(definition.tracker.kind)
    const credentials = source === undefined ? [] : await source.credentialStatuses?.().catch(() => []) ?? []
    const capabilities = source?.capabilities?.() ?? { create: false, update: false, delete: false, states: [] }
    const firstCredential = credentials[0]
    const context = source?.context()
    const runtimeIssues = [...this.runtimeArchive.values()].sort(runtimeOrder)
    const totals = runtimeIssues.reduce((sum, item) => addTokens(sum, item.tokens), emptyTokens())
    return {
      version: 2,
      generatedAt: new Date().toISOString(),
      selection: { mode: 'project' },
      ...(context === undefined ? {} : { context }),
      taskMutations: {
        canCreate: capabilities.create,
        canUpdate: capabilities.update,
        canDelete: capabilities.delete,
        states: capabilities.states,
      },
      paused: this.paused,
      board: {
        columns: definition === undefined ? [] : buildColumns(this.board, definition),
        total: this.board.length,
      },
      runtime: {
        running: this.running.size,
        retrying: this.retries.size,
        blocked: runtimeIssues.filter(item => item.phase === 'blocked').length,
        capacity: definition?.agent.max_concurrent_agents ?? 0,
        tokens: totals,
        ...(this.lastRefreshAt === undefined ? {} : { lastRefreshAt: this.lastRefreshAt }),
        ...(this.nextRefreshAt === undefined ? {} : { nextRefreshAt: this.nextRefreshAt }),
        ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
        issues: runtimeIssues,
      },
      configuration: {
        workflowPath: this.workflow.path,
        ...(definition === undefined ? {} : {
          workflowLoadedAt: definition.loadedAt,
          projectName: definition.project.name,
          trackerKind: definition.tracker.kind,
          ...(context === undefined ? {} : { projectRef: context.projectRef }),
          workspaceRoot: resolveWorkspaceRoot(definition.workspace.root, dirname(definition.sourcePath)),
          maxConcurrentAgents: definition.agent.max_concurrent_agents,
          maxTurns: definition.agent.max_turns,
          pollingIntervalMs: definition.polling.interval_ms,
        }),
        ...(workflowStatus.error === undefined ? {} : { workflowError: workflowStatus.error }),
        activeStates: definition?.tracker.active_states ?? [],
        terminalStates: definition?.tracker.terminal_states ?? [],
        agentProfile: this.config.agentProfile,
        permissionPreset: this.config.permissionPreset,
        ...(this.config.agentPreset === undefined ? {} : { agentPreset: this.config.agentPreset }),
        credentials,
        ...(firstCredential === undefined ? {} : {
          credentialRef: firstCredential.ref,
          credentialConfigured: firstCredential.configured,
          ...(firstCredential.source === undefined ? {} : { credentialSource: firstCredential.source }),
          credentialWritable: firstCredential.writable,
        }),
      },
      catalog: this.catalog.snapshot(),
    }
  }

  async createTask(input: CreateTaskInput, signal?: AbortSignal): Promise<void> {
    const definition = this.workflow.require()
    const source = this.sources.require(definition.tracker.kind)
    if (source.createTask === undefined) throw new Error(`Task source ${source.kind} does not support Dashboard task creation`)
    await source.createTask(input, signal)
    await this.refreshAfterMutation()
  }

  async updateTask(nativeRef: string, input: UpdateTaskInput, signal?: AbortSignal): Promise<void> {
    const definition = this.workflow.require()
    const source = this.sources.require(definition.tracker.kind)
    if (source.updateTask === undefined) throw new Error(`Task source ${source.kind} does not support Dashboard task updates`)
    await source.updateTask(nativeRef, input, signal)
    await this.refreshAfterMutation()
  }

  async deleteTask(nativeRef: string, signal?: AbortSignal): Promise<boolean> {
    const definition = this.workflow.require()
    const source = this.sources.require(definition.tracker.kind)
    if (source.deleteTask === undefined) throw new Error(`Task source ${source.kind} does not support Dashboard task deletion`)
    const deleted = await source.deleteTask(nativeRef, signal)
    if (deleted) await this.refreshAfterMutation()
    return deleted
  }

  /** Wait out a poll that may have captured pre-mutation state, then force one fresh read. */
  private async refreshAfterMutation(): Promise<void> {
    while (this.refreshing !== undefined) await this.refreshing
    await this.refresh()
  }

  issueDetail(key: string): IssueDetailView | undefined {
    const issue = this.board.find(candidate => issueKey(candidate) === key)
    if (issue === undefined) return undefined
    const runtime = this.runtimeArchive.get(key)
    const lifecycleSessions = this.catalog.lifecycleSessionsFor(this.config.projectId, key)
    return {
      issue,
      ...(runtime === undefined ? {} : { runtime }),
      ...(lifecycleSessions.length === 0 ? {} : { lifecycleSessions }),
    }
  }

  issueTimeline(key: string, options: TaskTimelineOptions = {}): TaskTimelinePage | undefined {
    const detail = this.issueDetail(key)
    if (detail === undefined) return undefined
    const archive = this.timelineArchive.get(key)?.snapshot()
    return buildTaskTimelinePage(
      detail,
      options,
      archive?.events ?? detail.runtime?.recentEvents ?? [],
      archive?.truncated ?? false,
    )
  }

  private async poll(dispatchEnabled: boolean): Promise<void> {
    if (this.stopped || (dispatchEnabled && !this.active)) return
    try {
      const definition = this.workflow.require()
      const source = this.sources.require(definition.tracker.kind)
      const board = await source.listBoardIssues()
      this.board = board
      this.lastRefreshAt = new Date().toISOString()
      this.lastError = undefined
      await this.reconcileRuntime(board, definition)
      // Provider reads can outlive a project/global selection change. Re-check
      // ownership after the await so stale polls cannot launch new Agents.
      if (dispatchEnabled && this.active && !this.paused) this.dispatch(board, definition)
    } catch (error) {
      this.lastRefreshAt = new Date().toISOString()
      this.lastError = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn('dsh-dashboard: poll failed: %s', this.lastError)
    }
  }

  private async reconcileRuntime(board: readonly TaskIssue[], definition: WorkflowDefinition): Promise<void> {
    const byKey = new Map(board.map(issue => [issueKey(issue), issue]))
    const active = new Set(definition.tracker.active_states.map(normalizedState))
    const terminal = new Set(definition.tracker.terminal_states.map(normalizedState))

    for (const [key, record] of this.running) {
      const current = byKey.get(key)
      if (current === undefined) {
        this.manualStops.add(key)
        record.abort.abort(new Error('issue disappeared from the current task source; preserving workspace'))
      } else if (terminal.has(normalizedState(current.state.name))) {
        record.issue = current
        this.terminalStops.add(key)
        record.abort.abort(new Error('issue reached a terminal state'))
      } else if (!active.has(normalizedState(current.state.name))) {
        // The worker may own this transition (for example Working -> User Test).
        // Let its current turn close and verify the new state itself so the
        // durable session ends completed rather than as orchestration-cancelled.
        record.issue = current
        record.runtime = { ...record.runtime, state: current.state.name, updatedAt: new Date().toISOString() }
        this.runtimeArchive.set(key, record.runtime)
      } else {
        record.issue = current
        if (record.runtime.state !== current.state.name) {
          record.runtime = { ...record.runtime, state: current.state.name, updatedAt: new Date().toISOString() }
          this.runtimeArchive.set(key, record.runtime)
        }
      }
    }

    for (const [key] of this.retries) {
      const current = byKey.get(key)
      if (current !== undefined && terminal.has(normalizedState(current.state.name))) {
        try {
          await this.workspaces.remove(current, definition)
          this.retries.delete(key)
          this.runtimeArchive.delete(key)
        } catch (removeError) {
          this.ctx.logger.warn('dsh-dashboard: terminal retry workspace cleanup failed for %s: %s', current.identifier, String(removeError))
        }
      } else if (current === undefined || !active.has(normalizedState(current.state.name))) {
        this.retries.delete(key)
        this.runtimeArchive.delete(key)
      }
    }

    for (const issue of board) {
      const key = issueKey(issue)
      if (this.running.has(key) || this.retries.has(key)) continue
      const hold = this.currentHold(issue)
      if (hold !== undefined) {
        const previous = this.runtimeArchive.get(key)
        const unchanged = previous?.phase === 'blocked' && previous.blocked?.reason === hold.reason
        const timestamp = unchanged ? previous.updatedAt : new Date().toISOString()
        this.runtimeArchive.set(key, {
          key,
          identifier: issue.identifier,
          phase: 'blocked',
          state: issue.state.name,
          turnCount: previous?.turnCount ?? 0,
          phaseChangedAt: timestamp,
          updatedAt: timestamp,
          workerHost: this.config.workerHost,
          tokens: previous?.tokens ?? emptyTokens(),
          blocked: { reason: hold.reason },
          recentEvents: previous?.recentEvents ?? [],
        })
      } else if (active.has(normalizedState(issue.state.name)) && !issue.dispatchable) {
        const previous = this.runtimeArchive.get(key)
        const reason = blockerReason(issue)
        const unchanged = previous?.phase === 'blocked' && previous.blocked?.reason === reason
        const now = unchanged ? previous.updatedAt : new Date().toISOString()
        const view: IssueRuntimeView = {
          key,
          identifier: issue.identifier,
          phase: 'blocked',
          state: issue.state.name,
          turnCount: 0,
          phaseChangedAt: now,
          updatedAt: now,
          workerHost: this.config.workerHost,
          tokens: previous?.tokens ?? emptyTokens(),
          blocked: { reason },
          recentEvents: previous?.recentEvents ?? [],
        }
        this.runtimeArchive.set(key, view)
        if (!unchanged) this.captureTimelineEvent(key, this.schedulerTimelineEvent('scheduler.blocked', 'Agent blocked', now, reason))
      } else if (this.runtimeArchive.get(key)?.phase === 'blocked') {
        this.runtimeArchive.delete(key)
      }
    }

    for (const key of this.timelineArchive.keys()) {
      if (!byKey.has(key) && !this.running.has(key) && !this.retries.has(key)) this.timelineArchive.delete(key)
    }
  }

  private dispatch(board: readonly TaskIssue[], definition: WorkflowDefinition): void {
    const active = new Set(definition.tracker.active_states.map(normalizedState))
    const terminal = new Set(definition.tracker.terminal_states.map(normalizedState))
    const now = Date.now()
    const stateCounts = new Map<string, number>()
    for (const running of this.running.values()) {
      const state = normalizedState(running.issue.state.name)
      stateCounts.set(state, (stateCounts.get(state) ?? 0) + 1)
    }
    const candidates = board
      .filter(issue => active.has(normalizedState(issue.state.name)))
      .filter(issue => !terminal.has(normalizedState(issue.state.name)))
      .filter(issue => issue.dispatchable)
      .filter(issue => hasRequiredLabels(issue, definition.tracker.required_labels))
      .filter(issue => this.currentHold(issue) === undefined)
      .filter(issue => !this.running.has(issueKey(issue)))
      .filter((issue) => {
        const retry = this.retries.get(issueKey(issue))
        return retry === undefined || retry.dueAt <= now
      })
      .sort(compareCandidates)

    for (const issue of candidates) {
      if (this.running.size >= definition.agent.max_concurrent_agents) break
      const state = normalizedState(issue.state.name)
      const limit = stateLimit(definition.agent.max_concurrent_agents_by_state, issue.state.name)
      if (limit !== undefined && (stateCounts.get(state) ?? 0) >= limit) continue
      const retry = this.retries.get(issueKey(issue))
      if (retry !== undefined) this.retries.delete(issueKey(issue))
      const binding = this.catalog.workerSession(this.config.projectId, issueKey(issue))
      this.launch(issue, definition, retry?.attempt ?? (binding?.status === 'running' ? binding.failureCount ?? 0 : 0))
      stateCounts.set(state, (stateCounts.get(state) ?? 0) + 1)
    }
  }

  private launch(issue: TaskIssue, definition: WorkflowDefinition, attempt: number): void {
    const key = issueKey(issue)
    const abort = new AbortController()
    const now = new Date().toISOString()
    const previous = this.runtimeArchive.get(key)
    const binding = this.catalog.workerSession(this.config.projectId, key)
    const runtime: IssueRuntimeView = {
      key,
      identifier: issue.identifier,
      phase: 'running',
      state: issue.state.name,
      turnCount: previous?.turnCount ?? 0,
      startedAt: now,
      phaseChangedAt: now,
      updatedAt: now,
      workerHost: this.config.workerHost,
      ...(binding?.sessionId === undefined ? {} : { sessionId: SessionId(binding.sessionId) }),
      tokens: previous?.tokens ?? emptyTokens(),
      recentEvents: previous?.recentEvents ?? [],
    }
    const record: RunningRecord = { issue, workflow: definition, abort, attempt, runtime }
    this.running.set(key, record)
    this.runtimeArchive.set(key, runtime)
    this.captureTimelineEvent(key, this.schedulerTimelineEvent('scheduler.running', 'Agent running', now))
    void this.execute(record).finally(() => {
      this.running.delete(key)
      this.schedule(0)
    })
  }

  private async execute(record: RunningRecord): Promise<void> {
    const { issue, workflow: definition, abort, attempt } = record
    const key = issueKey(issue)
    let workspacePath: string | undefined
    let afterRunCompleted = false
    try {
      const prepared = await this.workspaces.prepare(issue, definition, abort.signal)
      workspacePath = prepared.path
      await this.workspaces.beforeRun(workspacePath, issue, definition, abort.signal)
      const result = await this.runLifecycle(record, workspacePath)
      if (result.kind === 'terminal') {
        await this.workspaces.afterRun(workspacePath, issue, definition)
        afterRunCompleted = true
        await this.workspaces.remove(result.issue ?? issue, definition)
        this.runtimeArchive.delete(key)
      } else if (result.kind === 'exhausted') {
        await this.hold(record.issue, `Agent reached the cumulative max_turns limit (${definition.agent.max_turns}); revise the card to resume`)
      } else {
        this.runtimeArchive.delete(key)
      }
    } catch (error) {
      const manuallyStopped = this.manualStops.delete(key)
      const terminal = this.terminalStops.delete(key)
      if (terminal) {
        if (workspacePath !== undefined && !afterRunCompleted) {
          await this.workspaces.afterRun(workspacePath, record.issue, definition)
          afterRunCompleted = true
        }
        await this.workspaces.remove(record.issue, definition).catch(removeError => {
          this.ctx.logger.warn('dsh-dashboard: terminal workspace cleanup failed for %s: %s', record.issue.identifier, String(removeError))
        })
        this.runtimeArchive.delete(key)
      } else if (manuallyStopped) {
        // stopIssue persisted a revision-bound hold before cancellation.
      } else if (this.stopped) {
        // Keep the binding runnable: a replacement plugin process resumes it.
      } else {
        const nextAttempt = attempt + 1
        const message = error instanceof Error ? error.message : String(error)
        if (error instanceof AgentBlockedError || isPermanentFailure(error) || nextAttempt >= 5) {
          await this.hold(record.issue, error instanceof AgentBlockedError
            ? message
            : `${message} (held after ${nextAttempt} failed attempt${nextAttempt === 1 ? '' : 's'}; revise the card to resume)`)
        } else {
          const retryBinding = this.catalog.workerSession(this.config.projectId, key)
          if (retryBinding?.sessionId !== undefined) await this.saveBinding(record.issue, retryBinding.sessionId, 'running', undefined, nextAttempt)
          const delay = failureRetryDelay(nextAttempt, definition.agent.max_retry_backoff_ms)
          this.scheduleRetry(record, nextAttempt, delay, message)
        }
      }
    } finally {
      if (workspacePath !== undefined && !afterRunCompleted) await this.workspaces.afterRun(workspacePath, issue, definition)
      this.manualStops.delete(key)
      this.terminalStops.delete(key)
    }
  }

  /** Runs roles serially: at most one workspace-writing role can own a task at once. */
  private async runLifecycle(record: RunningRecord, workspacePath: string): Promise<AgentRunResult> {
    const { issue, workflow, attempt, abort } = record
    const key = issueKey(issue)
    const source = this.sources.require(workflow.tracker.kind)
    const lifecycle = workflow.lifecycle ?? DEFAULT_LIFECYCLE_POLICY
    const legacy = !lifecycle.enabled
    const binding = this.catalog.workerSession(this.config.projectId, key)
    if (legacy) {
      const result = await this.runner.run({
        issue, source, workflow, workspacePath, attempt,
        ...(binding?.sessionId === undefined ? {} : { sessionId: SessionId(binding.sessionId) }),
        onSessionBound: async sessionId => await this.saveBinding(issue, sessionId, 'running', undefined, 0),
        signal: abort.signal,
        onRuntime: view => this.updateRuntime(record, view),
      })
      record.runtime = result.runtime
      this.runtimeArchive.set(key, result.runtime)
      return result
    }

    const failureCount = binding?.failureCount ?? 0
    const roles = resolveLifecyclePipeline(lifecycle, issue.state.name, issue.labels, failureCount)
    let aggregate = record.runtime
    let handoff: string | undefined
    let last: AgentRunResult | undefined
    for (const role of roles) {
      const existing = this.catalog.lifecycleSession(this.config.projectId, key, role)
      if (existing?.status === 'completed' && existing.issueRevision === issueRevision(issue)) {
        handoff = existing.handoff ?? handoff
        continue
      }
      const route = lifecycle.roles[role]
      const fallback = this.ctx.agentDefaultModel.currentSelection()
      const provider = route.provider ?? fallback.provider
      const model = route.model ?? fallback.model
      const roleStartedAt = new Date().toISOString()
      const current: LifecycleSessionRecord = {
        projectId: this.config.projectId,
        issueKey: key,
        role,
        ...(existing?.sessionId === undefined ? {} : { sessionId: existing.sessionId }),
        status: 'running',
        issueRevision: issueRevision(issue),
        provider,
        model,
        ...(route.reasoning_effort === undefined ? {} : { reasoningEffort: route.reasoning_effort }),
        permissionPreset: route.permission_preset,
        startedAt: existing?.startedAt ?? roleStartedAt,
        updatedAt: roleStartedAt,
        tokens: existing?.tokens ?? emptyTokens(),
      }
      await this.catalog.saveLifecycleSession(current)
      this.projectLifecycleRuntime(record, aggregate, role)
      const baseline = aggregate
      const merge = (view: IssueRuntimeView): IssueRuntimeView => ({
        ...view,
        turnCount: baseline.turnCount + view.turnCount,
        tokens: addTokens(baseline.tokens, view.tokens),
        recentEvents: [...view.recentEvents, ...baseline.recentEvents].slice(0, 12),
        lifecycle: { activeRole: role, sessions: this.catalog.lifecycleSessionsFor(this.config.projectId, key) },
      })
      try {
        const result = await this.runner.run({
          issue, source, workflow, workspacePath, attempt,
          ...(existing?.sessionId === undefined ? {} : { sessionId: SessionId(existing.sessionId) }),
          lifecycle: {
            role,
            provider,
            model,
            ...(route.reasoning_effort === undefined ? {} : { reasoningEffort: route.reasoning_effort }),
            permissionPreset: route.permission_preset,
            maxTurns: route.max_turns ?? (role === 'implementation' ? workflow.agent.max_turns : 2),
            ...(handoff === undefined ? {} : { handoff }),
            instruction: rolePrompt(role),
          },
          onSessionBound: async sessionId => {
            await this.catalog.saveLifecycleSession({ ...current, sessionId, updatedAt: new Date().toISOString() })
            await this.saveBinding(issue, sessionId, 'running', undefined, 0)
          },
          signal: abort.signal,
          onRuntime: view => {
            const merged = merge(view)
            record.runtime = merged
            this.runtimeArchive.set(key, merged)
            this.captureTimelineEvent(key, merged.recentEvents[0])
          },
        })
        aggregate = merge(result.runtime)
        const finishedAt = new Date().toISOString()
        handoff = compactHandoff(result.handoff) ?? handoff
        const completed: LifecycleSessionRecord = {
          ...current,
          ...(existing?.sessionId === undefined ? { sessionId: String(result.runtime.sessionId) } : {}),
          status: 'completed',
          updatedAt: finishedAt,
          finishedAt,
          runtimeMs: Math.max(0, Date.parse(finishedAt) - Date.parse(roleStartedAt)),
          tokens: result.runtime.tokens,
          ...(handoff === undefined ? {} : { handoff }),
        }
        await this.catalog.saveLifecycleSession(completed)
        aggregate = { ...aggregate, lifecycle: { sessions: this.catalog.lifecycleSessionsFor(this.config.projectId, key) } }
        record.runtime = aggregate
        this.runtimeArchive.set(key, aggregate)
        last = { ...result, runtime: aggregate, ...(handoff === undefined ? {} : { handoff }) }
        if (result.kind === 'terminal' || result.kind === 'inactive') return last
        // A role-local exhaustion is completion for planning/QA/review/escalation;
        // implementation exhaustion remains the existing max-turn safety hold.
        if (role === 'implementation' && result.kind === 'exhausted') return last
      } catch (error) {
        const failedAt = new Date().toISOString()
        await this.catalog.saveLifecycleSession({
          ...current,
          status: 'failed',
          updatedAt: failedAt,
          finishedAt: failedAt,
          runtimeMs: Math.max(0, Date.parse(failedAt) - Date.parse(roleStartedAt)),
          tokens: aggregate.tokens,
          error: String(error instanceof Error ? error.message : error).slice(0, 2000),
        })
        throw error
      }
    }
    return last ?? { kind: 'inactive', issue, runtime: aggregate, ...(handoff === undefined ? {} : { handoff }) }
  }

  private updateRuntime(record: RunningRecord, view: IssueRuntimeView): void {
    record.runtime = view
    this.runtimeArchive.set(issueKey(record.issue), view)
    this.captureTimelineEvent(issueKey(record.issue), view.recentEvents[0])
  }

  private projectLifecycleRuntime(record: RunningRecord, base: IssueRuntimeView, role: LifecycleRole): void {
    const key = issueKey(record.issue)
    const runtime: IssueRuntimeView = {
      ...base,
      lifecycle: { activeRole: role, sessions: this.catalog.lifecycleSessionsFor(this.config.projectId, key) },
    }
    record.runtime = runtime
    this.runtimeArchive.set(key, runtime)
  }

  private captureTimelineEvent(key: string, event: RuntimeEventView | undefined): void {
    if (event === undefined) return
    let archive = this.timelineArchive.get(key)
    if (archive === undefined) {
      archive = new RuntimeTimelineArchive()
      this.timelineArchive.set(key, archive)
    }
    archive.append(event)
  }

  private schedulerTimelineEvent(type: string, title: string, at: string, detail?: string): RuntimeEventView {
    this.timelineEventSequence += 1
    return {
      id: `host:${this.timelineEventSequence.toString(36)}`,
      type,
      title,
      ...(detail === undefined ? {} : { detail }),
      at,
    }
  }

  private scheduleRetry(record: RunningRecord, attempt: number, delayMs: number, error: string): void {
    const dueAt = Date.now() + delayMs
    const changedAt = new Date().toISOString()
    const view: IssueRuntimeView = {
      ...record.runtime,
      phase: 'retrying',
      phaseChangedAt: changedAt,
      updatedAt: changedAt,
      retry: { attempt, dueAt: new Date(dueAt).toISOString(), error },
    }
    const key = issueKey(record.issue)
    this.retries.set(key, { issue: record.issue, attempt, dueAt, error, runtime: view })
    this.runtimeArchive.set(key, view)
    this.captureTimelineEvent(key, this.schedulerTimelineEvent('scheduler.retrying', 'Agent retrying', view.updatedAt, error))
    this.ctx.logger.warn('dsh-dashboard: retrying %s in %dms (attempt %d): %s', record.issue.identifier, delayMs, attempt, error)
  }

  private currentHold(issue: TaskIssue): { readonly issueRevision: string; readonly reason: string } | undefined {
    const key = issueKey(issue)
    const revision = issueRevision(issue)
    const memory = this.holds.get(key)
    if (memory !== undefined) {
      if (memory.issueRevision === revision) return memory
      this.holds.delete(key)
    }
    const persisted = this.catalog.workerSession(this.config.projectId, key)
    if (persisted?.status !== 'held' || persisted.issueRevision !== revision || persisted.holdReason === undefined) return undefined
    const hold = { issueRevision: persisted.issueRevision, reason: persisted.holdReason }
    this.holds.set(key, hold)
    return hold
  }

  private async hold(issue: TaskIssue, reason: string): Promise<void> {
    const key = issueKey(issue)
    const revision = issueRevision(issue)
    this.holds.set(key, { issueRevision: revision, reason })
    this.retries.delete(key)
    const binding = this.catalog.workerSession(this.config.projectId, key)
    await this.saveBinding(issue, binding?.sessionId, 'held', reason)
    const previous = this.runtimeArchive.get(key)
    if (previous !== undefined) {
      const timestamp = new Date().toISOString()
      this.runtimeArchive.set(key, {
        ...previous,
        phase: 'blocked',
        state: issue.state.name,
        phaseChangedAt: timestamp,
        updatedAt: timestamp,
        blocked: { reason },
      })
    }
  }

  private async saveBinding(
    issue: TaskIssue,
    sessionId: string | undefined,
    status: WorkerSessionRecord['status'],
    holdReason?: string,
    failureCount?: number,
  ): Promise<void> {
    const existing = this.catalog.workerSession(this.config.projectId, issueKey(issue))
    const timestamp = new Date().toISOString()
    await this.catalog.saveWorkerSession({
      projectId: this.config.projectId,
      issueKey: issueKey(issue),
      ...(sessionId === undefined ? {} : { sessionId }),
      status,
      failureCount: failureCount ?? existing?.failureCount ?? 0,
      issueRevision: issueRevision(issue),
      ...(holdReason === undefined ? {} : { holdReason }),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    })
  }

  private scheduleNext(): void {
    if (this.stopped || !this.active) return
    let interval = 5000
    try {
      interval = this.workflow.require().polling.interval_ms
    } catch {
      // An invalid first load still gets periodic chances to recover.
    }
    const nextPoll = Date.now() + interval
    let next = nextPoll
    for (const retry of this.retries.values()) next = Math.min(next, retry.dueAt)
    this.schedule(Math.max(0, next - Date.now()))
  }

  private schedule(delayMs: number): void {
    if (this.stopped || !this.active) return
    if (this.timer !== undefined) clearTimeout(this.timer)
    const dueAt = Date.now() + delayMs
    this.nextRefreshAt = new Date(dueAt).toISOString()
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.refresh()
    }, delayMs)
  }
}

function buildColumns(issues: readonly TaskIssue[], workflow: WorkflowDefinition): BoardColumn[] {
  const stateMap = new Map<string, { name: string; type?: string; color?: string; position: number; issues: TaskIssue[] }>()
  const declaredStates = [...new Set([
    ...workflow.dashboard.visible_states,
    ...workflow.tracker.active_states,
    ...workflow.tracker.terminal_states,
  ])]
  const terminal = new Set(workflow.tracker.terminal_states.map(normalizedState))
  for (const [position, name] of declaredStates.entries()) {
    stateMap.set(normalizedState(name), {
      name,
      type: terminal.has(normalizedState(name)) ? 'completed' : 'started',
      position,
      issues: [],
    })
  }
  for (const issue of issues) {
    const key = normalizedState(issue.state.name)
    const existing = stateMap.get(key)
    if (existing === undefined) {
      stateMap.set(key, {
        name: issue.state.name,
        ...(issue.state.type === undefined ? {} : { type: issue.state.type }),
        ...(issue.state.color === undefined ? {} : { color: issue.state.color }),
        position: issue.state.position ?? Number.MAX_SAFE_INTEGER,
        issues: [issue],
      })
    } else {
      existing.issues.push(issue)
      existing.position = Math.min(existing.position, issue.state.position ?? existing.position)
    }
  }
  const visible = new Set(workflow.dashboard.visible_states.map(normalizedState))
  return [...stateMap.values()]
    .sort((left, right) => left.position - right.position || left.name.localeCompare(right.name, 'en-US'))
    .map(state => ({
      name: state.name,
      ...(state.type === undefined ? {} : { type: state.type }),
      ...(state.color === undefined ? {} : { color: state.color }),
      position: state.position,
      hidden: visible.size > 0 && !visible.has(normalizedState(state.name)),
      issues: state.issues.sort(compareCandidates),
    }))
}

function blockerReason(issue: TaskIssue): string {
  if (issue.blockedBy.length > 0) {
    return `Blocked by ${issue.blockedBy.map(item => item.identifier ?? item.nativeRef ?? 'another issue').join(', ')}`
  }
  return 'Not dispatchable under the current tracker routing policy'
}

function issueRevision(issue: TaskIssue): string {
  const value = issue.updatedAt ?? JSON.stringify({
    state: normalizedState(issue.state.name),
    title: issue.title,
    description: issue.description ?? null,
    priority: issue.priority ?? null,
  })
  return createHash('sha256').update(value).digest('hex')
}

function isPermanentFailure(error: unknown): boolean {
  if (error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError) return true
  const message = error instanceof Error ? error.message : String(error)
  return /(?:authentication|authorization|permission denied|invalid (?:config|configuration|workflow)|not configured|unsupported|not found)/iu.test(message)
}

function runtimeOrder(left: IssueRuntimeView, right: IssueRuntimeView): number {
  const order = { running: 0, retrying: 1, blocked: 2, idle: 3 } as const
  return order[left.phase] - order[right.phase] || left.identifier.localeCompare(right.identifier, 'en-US')
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  while (!predicate()) await new Promise(resolve => setTimeout(resolve, 10))
}

export function totalTokens(issues: readonly IssueRuntimeView[]): TokenTotals {
  return issues.reduce((sum, issue) => addTokens(sum, issue.tokens), emptyTokens())
}
