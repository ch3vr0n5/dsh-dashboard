import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { AgentRunResult, HarnessAgentRunner } from '../src/agent/harness-runner.ts'
import type { TaskIssue } from '../src/domain/issue.ts'
import { issueKey } from '../src/domain/issue.ts'
import { DashboardOrchestrator } from '../src/orchestrator/orchestrator.ts'
import type { IssueRuntimeView } from '../src/runtime/types.ts'
import { emptyTokens } from '../src/runtime/types.ts'
import type { TaskSource, TaskSourceRegistry } from '../src/task-source/index.ts'
import type { WorkflowStore } from '../src/workflow/store.ts'
import type { WorkflowDefinition } from '../src/workflow/types.ts'
import type { WorkspaceManager } from '../src/workspace/manager.ts'
import type { ProjectCatalog } from '../src/catalog/catalog.ts'
import type { LifecycleSessionRecord, WorkerSessionRecord } from '../src/catalog/types.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import { DEFAULT_LIFECYCLE_POLICY } from '../src/lifecycle/policy.ts'

interface TestRunningRecord {
  issue: TaskIssue
  workflow: WorkflowDefinition
  readonly abort: AbortController
  readonly attempt: number
  runtime: IssueRuntimeView
}

interface TestRetryRecord {
  readonly issue: TaskIssue
  readonly attempt: number
  readonly dueAt: number
  readonly error: string
  readonly runtime: IssueRuntimeView
}

interface OrchestratorAccess {
  readonly running: Map<string, TestRunningRecord>
  readonly retries: Map<string, TestRetryRecord>
  readonly runtimeArchive: Map<string, IssueRuntimeView>
  readonly manualStops: Set<string>
  readonly terminalStops: Set<string>
  readonly holds: Map<string, { readonly issueRevision: string; readonly reason: string }>
  stopIssue(key: string): boolean
  reconcileRuntime(board: readonly TaskIssue[], definition: WorkflowDefinition): Promise<void>
  execute(record: TestRunningRecord): Promise<void>
  runLifecycle(record: TestRunningRecord, workspacePath: string): Promise<AgentRunResult>
  dispatch(board: readonly TaskIssue[], definition: WorkflowDefinition): void
  launch(issue: TaskIssue, definition: WorkflowDefinition, attempt: number): void
}

describe('DashboardOrchestrator reconciliation', () => {
  it('forces a fresh board read after a mutation overlaps an older poll', async () => {
    let releaseFirstRead: (() => void) | undefined
    const firstReadGate = new Promise<void>(accept => { releaseFirstRead = accept })
    let current: readonly TaskIssue[] = [task('Todo')]
    let reads = 0
    const source = {
      kind: 'linear',
      context: () => ({ kind: 'linear', providerLabel: 'Linear', projectLabel: 'ENG', projectRef: 'ENG' }),
      listBoardIssues: vi.fn(async () => {
        reads += 1
        const captured = current
        if (reads === 1) await firstReadGate
        return captured
      }),
      listIssuesByStates: async () => [],
      getIssuesByNativeRefs: async () => current,
      updateTask: vi.fn(async () => {
        current = [task('Done')]
        return current[0]!
      }),
    } satisfies TaskSource
    const store = {
      path: 'WORKFLOW.md',
      require: () => definition,
      status: () => ({ current: definition }),
    } as unknown as WorkflowStore
    const orchestrator = new DashboardOrchestrator(
      { logger: { warn: vi.fn() } } as unknown as Context,
      store,
      { require: vi.fn(() => source) } as unknown as TaskSourceRegistry,
      {} as WorkspaceManager,
      {} as HarnessAgentRunner,
      emptyCatalog(),
      { projectId: 'project-1', agentProfile: 'default', permissionPreset: 'workspace-write', workerHost: 'test' },
    )
    orchestrator.setPaused(true)

    const stalePoll = orchestrator.refresh()
    await vi.waitFor(() => { expect(reads).toBe(1) })
    const mutation = orchestrator.updateTask('issue-1', { state: 'Done' })
    await vi.waitFor(() => { expect(source.updateTask).toHaveBeenCalledOnce() })
    releaseFirstRead?.()
    await Promise.all([stalePoll, mutation])

    expect(source.listBoardIssues).toHaveBeenCalledTimes(2)
    const snapshot = await orchestrator.snapshot()
    expect(snapshot.board.columns.flatMap(column => column.issues)).toMatchObject([{ state: { name: 'Done' } }])
    const timer = (orchestrator as unknown as { timer?: NodeJS.Timeout }).timer
    if (timer !== undefined) clearTimeout(timer)
  })

  it('does not dispatch a provider result that finishes after the project is deactivated', async () => {
    let releaseRead: (() => void) | undefined
    const readGate = new Promise<void>(accept => { releaseRead = accept })
    const source = {
      kind: 'linear',
      context: () => ({ kind: 'linear', providerLabel: 'Linear', projectLabel: 'ENG', projectRef: 'ENG' }),
      listBoardIssues: vi.fn(async () => { await readGate; return [task('Todo')] }),
      listIssuesByStates: async () => [],
      getIssuesByNativeRefs: async () => [],
    } satisfies TaskSource
    const store = {
      path: 'WORKFLOW.md',
      require: () => definition,
      status: () => ({ current: definition }),
    } as unknown as WorkflowStore
    const orchestrator = new DashboardOrchestrator(
      { logger: { warn: vi.fn() } } as unknown as Context,
      store,
      { require: vi.fn(() => source) } as unknown as TaskSourceRegistry,
      {} as WorkspaceManager,
      {} as HarnessAgentRunner,
      emptyCatalog(),
      { projectId: 'project-1', agentProfile: 'default', permissionPreset: 'workspace-write', workerHost: 'test' },
    )
    const access = orchestrator as unknown as { dispatch(board: readonly TaskIssue[], workflow: WorkflowDefinition): void }
    const dispatch = vi.spyOn(access, 'dispatch')

    const refresh = orchestrator.refresh()
    await vi.waitFor(() => { expect(source.listBoardIssues).toHaveBeenCalledOnce() })
    orchestrator.setActive(false)
    releaseRead?.()
    await refresh

    expect(dispatch).not.toHaveBeenCalled()
  })

  it('runs an active poll after a read-only overview refresh finishes', async () => {
    let releaseOverview: (() => void) | undefined
    const overviewGate = new Promise<void>(accept => { releaseOverview = accept })
    let reads = 0
    const source = {
      kind: 'linear',
      context: () => ({ kind: 'linear', providerLabel: 'Linear', projectLabel: 'ENG', projectRef: 'ENG' }),
      listBoardIssues: vi.fn(async () => {
        reads += 1
        if (reads === 1) await overviewGate
        return [task('Todo')]
      }),
      listIssuesByStates: async () => [],
      getIssuesByNativeRefs: async () => [],
    } satisfies TaskSource
    const store = {
      path: 'WORKFLOW.md',
      require: () => definition,
      status: () => ({ current: definition }),
    } as unknown as WorkflowStore
    const orchestrator = new DashboardOrchestrator(
      { logger: { warn: vi.fn() } } as unknown as Context,
      store,
      { require: vi.fn(() => source) } as unknown as TaskSourceRegistry,
      {} as WorkspaceManager,
      {} as HarnessAgentRunner,
      emptyCatalog(),
      { projectId: 'project-1', agentProfile: 'default', permissionPreset: 'workspace-write', workerHost: 'test' },
    )
    const access = orchestrator as unknown as { dispatch(board: readonly TaskIssue[], workflow: WorkflowDefinition): void }
    const dispatch = vi.spyOn(access, 'dispatch').mockImplementation(() => undefined)

    const overview = orchestrator.refreshOverview()
    await vi.waitFor(() => { expect(source.listBoardIssues).toHaveBeenCalledOnce() })
    const active = orchestrator.refresh()
    releaseOverview?.()
    await Promise.all([overview, active])

    expect(source.listBoardIssues).toHaveBeenCalledTimes(2)
    expect(dispatch).toHaveBeenCalledOnce()
    orchestrator.setActive(false)
  })

  it('stops a missing running issue without classifying it as terminal or removing its workspace', async () => {
    const fixture = createFixture()
    const record = runningRecord(task('Todo'))
    fixture.access.running.set(issueKey(record.issue), record)

    await fixture.access.reconcileRuntime([], definition)

    expect(record.abort.signal.aborted).toBe(true)
    expect(fixture.access.manualStops.has(issueKey(record.issue))).toBe(true)
    expect(fixture.access.terminalStops.has(issueKey(record.issue))).toBe(false)
    expect(fixture.remove).not.toHaveBeenCalled()
  })

  it('updates active running records before applying per-state concurrency counts', async () => {
    const fixture = createFixture()
    const record = runningRecord(task('Todo'))
    fixture.access.running.set(issueKey(record.issue), record)

    await fixture.access.reconcileRuntime([task('In Progress')], definition)

    expect(record.abort.signal.aborted).toBe(false)
    expect(record.issue.state.name).toBe('In Progress')
    expect(record.runtime.state).toBe('In Progress')
  })

  it('lets an agent-owned transition to an inactive review state finish gracefully', async () => {
    const fixture = createFixture()
    const record = runningRecord(task('Todo'))
    fixture.access.running.set(issueKey(record.issue), record)

    await fixture.access.reconcileRuntime([task('User Test')], definition)

    expect(record.abort.signal.aborted).toBe(false)
    expect(record.issue.state.name).toBe('User Test')
    expect(record.runtime.state).toBe('User Test')
  })

  it('removes the workspace when a retrying issue is confirmed terminal', async () => {
    const fixture = createFixture()
    const retryIssue = task('Todo')
    const retryRuntime = runtime(retryIssue, 'retrying')
    const key = issueKey(retryIssue)
    fixture.access.retries.set(key, { issue: retryIssue, attempt: 1, dueAt: Date.now() + 10_000, error: 'failed', runtime: retryRuntime })
    fixture.access.runtimeArchive.set(key, retryRuntime)
    const terminal = task('Done')

    await fixture.access.reconcileRuntime([terminal], definition)

    expect(fixture.remove).toHaveBeenCalledWith(terminal, definition)
    expect(fixture.access.retries.has(key)).toBe(false)
    expect(fixture.access.runtimeArchive.has(key)).toBe(false)
  })

  it('keeps terminal retry state when cleanup fails so the next poll retries removal', async () => {
    const remove = vi.fn(async () => { throw new Error('workspace busy') })
    const fixture = createFixture({ remove })
    const retryIssue = task('Todo')
    const retryRuntime = runtime(retryIssue, 'retrying')
    const key = issueKey(retryIssue)
    fixture.access.retries.set(key, { issue: retryIssue, attempt: 1, dueAt: Date.now(), error: 'failed', runtime: retryRuntime })
    fixture.access.runtimeArchive.set(key, retryRuntime)

    await fixture.access.reconcileRuntime([task('Done')], definition)

    expect(remove).toHaveBeenCalledOnce()
    expect(fixture.access.retries.has(key)).toBe(true)
    expect(fixture.access.runtimeArchive.has(key)).toBe(true)
  })

  it('runs after_run before before_remove and terminal workspace deletion', async () => {
    const order: string[] = []
    const fixture = createFixture({
      prepare: vi.fn(async () => { order.push('prepare'); return { path: 'C:\\workspace\\ENG-1', createdNow: false } }),
      beforeRun: vi.fn(async () => { order.push('before-run') }),
      afterRun: vi.fn(async () => { order.push('after-run') }),
      remove: vi.fn(async () => { order.push('remove'); return true }),
      run: vi.fn(async (request) => {
        order.push('agent')
        return { kind: 'terminal', issue: task('Done'), runtime: runtime(request.issue, 'running') } satisfies AgentRunResult
      }),
    })
    const record = runningRecord(task('Todo'))

    await fixture.access.execute(record)

    expect(order).toEqual(['prepare', 'before-run', 'agent', 'after-run', 'remove'])
  })

  it('runs after_run before cleanup when a polling transition aborts the agent as terminal', async () => {
    const order: string[] = []
    const fixture = createFixture({
      prepare: vi.fn(async () => { order.push('prepare'); return { path: 'C:\\workspace\\ENG-1', createdNow: false } }),
      beforeRun: vi.fn(async () => { order.push('before-run') }),
      afterRun: vi.fn(async () => { order.push('after-run') }),
      remove: vi.fn(async () => { order.push('remove'); return true }),
      run: vi.fn(async () => { order.push('agent'); throw new Error('issue reached a terminal state') }),
    })
    const record = runningRecord(task('Done'))
    fixture.access.terminalStops.add(issueKey(record.issue))

    await fixture.access.execute(record)

    expect(order).toEqual(['prepare', 'before-run', 'agent', 'after-run', 'remove'])
  })

  it('resumes the same persisted conversation after an orchestrator restart', async () => {
    const catalog = durableCatalog()
    const firstRun = vi.fn(async (request: Parameters<HarnessAgentRunner['run']>[0]) => {
      await request.onSessionBound(SessionId('dsh-dashboard-card-session'))
      return { kind: 'inactive', runtime: runtime(request.issue, 'running') } satisfies AgentRunResult
    })
    const first = createFixture({ catalog, run: firstRun })
    await first.access.execute(runningRecord(task('Todo', '2026-08-25T01:00:00.000Z')))

    const resumedRun = vi.fn(async (request: Parameters<HarnessAgentRunner['run']>[0]) => (
      { kind: 'inactive', runtime: runtime(request.issue, 'running') } satisfies AgentRunResult
    ))
    const restarted = createFixture({ catalog, run: resumedRun })
    await restarted.access.execute(runningRecord(task('Todo', '2026-08-25T01:00:00.000Z')))

    expect(resumedRun).toHaveBeenCalledOnce()
    expect(resumedRun.mock.calls[0]![0].sessionId).toBe('dsh-dashboard-card-session')
  })

  it('holds explicit stops until the card revision changes', async () => {
    const catalog = durableCatalog(workerBinding('running', 'old'))
    const fixture = createFixture({ catalog })
    const original = task('Todo', '2026-08-25T01:00:00.000Z')
    const record = runningRecord(original)
    fixture.access.running.set(issueKey(original), record)

    expect(fixture.access.stopIssue(issueKey(original))).toBe(true)
    await vi.waitFor(() => {
      expect(catalog.workerSession('project-1', issueKey(original))).toMatchObject({
        status: 'held',
        holdReason: 'Agent explicitly stopped from Dashboard',
      })
    })
    expect(record.abort.signal.aborted).toBe(true)
  })

  it('holds permanent failures and releases the hold for revised feedback', async () => {
    const catalog = durableCatalog(workerBinding('running', 'old'))
    const fixture = createFixture({
      catalog,
      run: vi.fn(async () => { throw new TypeError('invalid configuration') }),
    })
    const original = task('Todo', '2026-08-25T01:00:00.000Z')
    await fixture.access.execute(runningRecord(original))

    expect(catalog.workerSession('project-1', issueKey(original))).toMatchObject({
      sessionId: 'dsh-dashboard-card-session',
      status: 'held',
    })
    expect(fixture.access.retries.size).toBe(0)
    await fixture.access.reconcileRuntime([original], definition)
    expect(fixture.access.runtimeArchive.get(issueKey(original))?.phase).toBe('blocked')

    const revised = task('Todo', '2026-08-25T02:00:00.000Z')
    await fixture.access.reconcileRuntime([revised], definition)
    const launch = vi.spyOn(fixture.access, 'launch').mockImplementation(() => undefined)
    fixture.access.dispatch([revised], definition)
    expect(launch).toHaveBeenCalledOnce()
  })

  it('durably holds a permanent pre-session hook failure without inventing a session', async () => {
    const catalog = durableCatalog()
    const fixture = createFixture({
      catalog,
      beforeRun: vi.fn(async () => { throw new TypeError('invalid workflow hook configuration') }),
    })
    const issue = task('Todo', '2026-08-25T01:00:00.000Z')

    await fixture.access.execute(runningRecord(issue))

    expect(catalog.workerSession('project-1', issueKey(issue))).toMatchObject({ status: 'held' })
    expect(catalog.workerSession('project-1', issueKey(issue))?.sessionId).toBeUndefined()
  })

  it('retries transient failures against the same bound session', async () => {
    const catalog = durableCatalog(workerBinding('running', 'old'))
    const run = vi.fn(async (_request: Parameters<HarnessAgentRunner['run']>[0]) => { throw new Error('temporary gateway timeout') })
    const fixture = createFixture({ catalog, run })
    const issue = task('Todo', '2026-08-25T01:00:00.000Z')

    await fixture.access.execute(runningRecord(issue))

    expect(run.mock.calls[0]![0].sessionId).toBe('dsh-dashboard-card-session')
    expect(fixture.access.retries.get(issueKey(issue))).toMatchObject({ attempt: 1 })
    expect(catalog.workerSession('project-1', issueKey(issue))).toMatchObject({
      sessionId: 'dsh-dashboard-card-session',
      failureCount: 1,
    })
  })

  it('starts a fresh lifecycle attempt after failure without overwriting the prior attempt', async () => {
    const issue = task('Todo', '2026-08-25T01:00:00.000Z')
    const prior = lifecycleAttempt(issue, {
      attemptId: 'attempt-1', sessionId: 'session-1', status: 'failed',
      startedAt: '2026-08-25T00:00:00.000Z', updatedAt: '2026-08-25T00:05:00.000Z',
      finishedAt: '2026-08-25T00:05:00.000Z', error: 'interrupted',
    })
    const catalog = lifecycleCatalog([prior])
    const run = vi.fn(async (request: Parameters<HarnessAgentRunner['run']>[0]) => ({
      kind: 'exhausted' as const,
      runtime: { ...runtime(request.issue, 'running'), sessionId: SessionId('session-2') },
      handoff: 'Implementation complete; tests pass.',
    }))
    const fixture = createFixture({ catalog, run })
    const record = runningRecord(issue)
    record.workflow = lifecycleDefinition

    await fixture.access.runLifecycle(record, 'C:\\workspace\\ENG-1')

    expect(run.mock.calls[0]![0].sessionId).toBeUndefined()
    const attempts = catalog.lifecycleSessionsFor('project-1', issueKey(issue))
    expect(attempts).toHaveLength(2)
    expect(attempts[0]).toMatchObject({ attemptId: 'attempt-1', sessionId: 'session-1', status: 'failed' })
    expect(attempts[1]).toMatchObject({ sessionId: 'session-2', status: 'completed', handoff: 'Implementation complete; tests pass.' })
    expect(attempts[1]?.attemptId).not.toBe('attempt-1')
    expect(attempts[1]?.startedAt).not.toBe(prior.startedAt)
  })

  it('records a lifecycle role as failed when it ends without a compact handoff', async () => {
    const issue = task('Todo', '2026-08-25T01:00:00.000Z')
    const catalog = lifecycleCatalog()
    const fixture = createFixture({
      catalog,
      run: vi.fn(async request => {
        await request.onSessionBound(SessionId('interrupted-session'))
        return { kind: 'exhausted' as const, runtime: runtime(request.issue, 'running') }
      }),
    })
    const record = runningRecord(issue)
    record.workflow = lifecycleDefinition

    await expect(fixture.access.runLifecycle(record, 'C:\\workspace\\ENG-1')).rejects.toThrow(
      'lifecycle role implementation ended without a compact handoff',
    )
    expect(catalog.lifecycleSession('project-1', issueKey(issue), 'implementation')).toMatchObject({
      status: 'failed',
      sessionId: 'interrupted-session',
      error: 'lifecycle role implementation ended without a compact handoff',
    })
  })
})

function createFixture(overrides: {
  readonly prepare?: WorkspaceManager['prepare']
  readonly beforeRun?: WorkspaceManager['beforeRun']
  readonly afterRun?: WorkspaceManager['afterRun']
  readonly remove?: WorkspaceManager['remove']
  readonly run?: HarnessAgentRunner['run']
  readonly catalog?: ProjectCatalog
} = {}) {
  const source = {
    kind: 'linear',
    context: () => ({ kind: 'linear', providerLabel: 'Linear', projectLabel: 'ENG', projectRef: 'engineering' }),
    listBoardIssues: async () => [],
    listIssuesByStates: async () => [],
    getIssuesByNativeRefs: async () => [],
  } satisfies TaskSource
  const prepare = overrides.prepare ?? vi.fn(async () => ({ path: 'C:\\workspace\\ENG-1', createdNow: false }))
  const beforeRun = overrides.beforeRun ?? vi.fn(async () => {})
  const afterRun = overrides.afterRun ?? vi.fn(async () => {})
  const remove = overrides.remove ?? vi.fn(async () => true)
  const run = overrides.run ?? vi.fn(async request => ({ kind: 'inactive', runtime: runtime(request.issue, 'running') } satisfies AgentRunResult))
  const workspaces = { prepare, beforeRun, afterRun, remove } as unknown as WorkspaceManager
  const runner = { run } as unknown as HarnessAgentRunner
  const sources = { require: vi.fn(() => source) } as unknown as TaskSourceRegistry
  const orchestrator = new DashboardOrchestrator(
    {
      logger: { warn: vi.fn() },
      agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test-model' }) },
    } as unknown as Context,
    {} as WorkflowStore,
    sources,
    workspaces,
    runner,
    overrides.catalog ?? emptyCatalog(),
    { projectId: 'project-1', agentProfile: 'default', permissionPreset: 'workspace-write', workerHost: 'test' },
  )
  return { access: orchestrator as unknown as OrchestratorAccess, remove }
}

function task(state: string, updatedAt?: string): TaskIssue {
  return {
    sourceKind: 'linear', scopeRef: 'ENG', nativeRef: 'issue-1', identifier: 'ENG-1', title: 'Orchestrate safely',
    state: { name: state }, labels: [], blockedBy: [], dispatchable: true,
    ...(updatedAt === undefined ? {} : { updatedAt }),
  }
}

function runtime(issue: TaskIssue, phase: IssueRuntimeView['phase']): IssueRuntimeView {
  return {
    key: issueKey(issue), identifier: issue.identifier, phase, state: issue.state.name,
    turnCount: 0, phaseChangedAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), workerHost: 'test', tokens: emptyTokens(), recentEvents: [],
  }
}

function runningRecord(issue: TaskIssue): TestRunningRecord {
  return { issue, workflow: definition, abort: new AbortController(), attempt: 0, runtime: runtime(issue, 'running') }
}

const definition: WorkflowDefinition = {
  version: 1,
  project: { name: 'Test project', agent_profile: 'default' },
  tracker: {
    kind: 'linear', provider: { project_slug: 'engineering' }, required_labels: [],
    active_states: ['Todo', 'In Progress'], terminal_states: ['Done'],
  },
  polling: { interval_ms: 5000 },
  workspace: { root: 'C:\\workspace' },
  hooks: { timeout_ms: 10_000 },
  agent: {
    max_concurrent_agents: 2,
    max_concurrent_agents_by_state: { Todo: 1, 'In Progress': 1 },
    max_turns: 3,
    max_retry_backoff_ms: 60_000,
  },
  dashboard: { visible_states: [] },
  prompt: 'Work on {{ issue.identifier }}',
  sourcePath: 'WORKFLOW.md',
  loadedAt: new Date(0).toISOString(),
}

const lifecycleDefinition: WorkflowDefinition = {
  ...definition,
  lifecycle: {
    ...DEFAULT_LIFECYCLE_POLICY,
    enabled: true,
    state_roles: { todo: ['implementation'] },
  },
}

function emptyCatalog(): ProjectCatalog {
  return {
    snapshot: () => ({ projects: [], discoveryRoots: [], globalBrokerEnabled: false }),
    workerSession: () => undefined,
    saveWorkerSession: async () => {},
  } as unknown as ProjectCatalog
}

function workerBinding(status: WorkerSessionRecord['status'], issueRevision: string): WorkerSessionRecord {
  return {
    projectId: 'project-1',
    issueKey: issueKey(task('Todo')),
    sessionId: 'dsh-dashboard-card-session',
    status,
    issueRevision,
    ...(status === 'held' ? { holdReason: 'held for test' } : {}),
    createdAt: '2026-08-25T00:00:00.000Z',
    updatedAt: '2026-08-25T00:00:00.000Z',
  }
}

function durableCatalog(initial?: WorkerSessionRecord): ProjectCatalog {
  const records = new Map<string, WorkerSessionRecord>()
  if (initial !== undefined) records.set(initial.issueKey, initial)
  return {
    snapshot: () => ({ projects: [], discoveryRoots: [], globalBrokerEnabled: false }),
    workerSession: (_projectId: string, key: string) => records.get(key),
    saveWorkerSession: async (record: WorkerSessionRecord) => { records.set(record.issueKey, record) },
  } as unknown as ProjectCatalog
}

function lifecycleAttempt(issue: TaskIssue, overrides: Partial<LifecycleSessionRecord>): LifecycleSessionRecord {
  return {
    projectId: 'project-1', issueKey: issueKey(issue), role: 'implementation', status: 'running',
    issueRevision: '2026-08-25T01:00:00.000Z', provider: 'test', model: 'test-model',
    permissionPreset: 'workspace-write', startedAt: '2026-08-25T00:00:00.000Z',
    updatedAt: '2026-08-25T00:00:00.000Z', tokens: emptyTokens(), ...overrides,
  }
}

function lifecycleCatalog(initial: readonly LifecycleSessionRecord[] = []): ProjectCatalog {
  const records = [...initial]
  return {
    snapshot: () => ({ projects: [], discoveryRoots: [], globalBrokerEnabled: false }),
    workerSession: () => undefined,
    saveWorkerSession: async () => {},
    lifecycleSessionsFor: (_projectId: string, key: string) => records
      .filter(record => record.issueKey === key)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt)),
    lifecycleSession: (_projectId: string, key: string, role: LifecycleSessionRecord['role']) => records
      .filter(record => record.issueKey === key && record.role === role)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0],
    saveLifecycleSession: async (record: LifecycleSessionRecord) => {
      const index = records.findIndex(candidate => candidate.attemptId === record.attemptId)
      if (index === -1) records.push(record)
      else records[index] = record
    },
  } as unknown as ProjectCatalog
}
