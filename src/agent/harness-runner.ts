/** Same-thread multi-turn runner backed by the Harness Agent registry. */

import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-workspace'
import { installModelSelection, type AgentHandle, type ModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'
import type { TaskIssue } from '../domain/issue.ts'
import { issueKey, normalizedState } from '../domain/issue.ts'
import type { TaskSource } from '../task-source/index.ts'
import { resolveTaskSourceAgentTool } from '../task-source/index.ts'
import type { IssueRuntimeView, RuntimeEventView, TokenTotals } from '../runtime/types.ts'
import { emptyTokens } from '../runtime/types.ts'
import { promptFingerprint, renderIssuePrompt } from '../workflow/prompt.ts'
import type { WorkflowDefinition } from '../workflow/types.ts'
import type { LifecycleRole } from '../lifecycle/types.ts'
import { parseUserTestEvidencePatch } from '../lifecycle/user-test-evidence.ts'

const execFileAsync = promisify(execFile)

export interface HarnessRunnerConfig {
  readonly permissionPreset: string
  readonly agentPreset?: string
  readonly workerHost: string
}

export interface AgentRunRequest {
  readonly issue: TaskIssue
  readonly source: TaskSource
  readonly workflow: WorkflowDefinition
  readonly workspacePath: string
  readonly attempt: number
  /** Existing card-owned conversation. Absent only for the card's first worker. */
  readonly sessionId?: SessionId
  readonly lifecycle?: {
    readonly role: LifecycleRole
    readonly provider?: string
    readonly model?: string
    readonly reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh'
    readonly permissionPreset: string
    readonly maxTurns: number
    readonly handoff?: string
    readonly instruction?: string
  }
  /** Persist a newly-created conversation before any task prompt is submitted. */
  readonly onSessionBound: (sessionId: SessionId) => Promise<void>
  readonly signal: AbortSignal
  readonly onRuntime: (view: IssueRuntimeView) => void
}

export interface AgentRunResult {
  readonly kind: 'terminal' | 'exhausted' | 'inactive'
  readonly issue?: TaskIssue
  readonly runtime: IssueRuntimeView
  readonly handoff?: string
}

/** Creates or resumes the card-owned Harness Agent and enforces a cumulative turn budget. */
export class HarnessAgentRunner {
  constructor(private readonly ctx: Context, private readonly config: HarnessRunnerConfig) {
    ctx.permissionPresets.resolve(config.permissionPreset)
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const { issue, source, workflow, workspacePath, attempt, signal, onRuntime } = request
    const startedAt = new Date().toISOString()
    const sessionId = request.sessionId ?? SessionId(`dsh-dashboard-${randomUUID()}`)
    const resumed = request.sessionId !== undefined
    const inherited = this.ctx.agentDefaultModel.currentSelection()
    const selection: ModelSelection = request.lifecycle === undefined ? inherited : {
      provider: request.lifecycle.provider ?? inherited.provider,
      model: request.lifecycle.model ?? inherited.model,
      ...(request.lifecycle.reasoningEffort === undefined ? {} : { reasoningEffort: request.lifecycle.reasoningEffort as NonNullable<ModelSelection['reasoningEffort']> }),
    }
    const selected: ModelSelectionRef = { current: selection, assembled: undefined }
    const presets = this.ctx.get('agentPresets')
    if (this.config.agentPreset !== undefined && presets === undefined) {
      throw new Error(`dsh-dashboard: agentPreset ${JSON.stringify(this.config.agentPreset)} was configured but ctx.agentPresets is unavailable`)
    }
    const resolvedPreset = presets === undefined ? undefined : await presets.resolve(this.config.agentPreset)
    let runtime: IssueRuntimeView = {
      key: issueKey(issue),
      identifier: issue.identifier,
      phase: 'running',
      state: issue.state.name,
      sessionId,
      turnCount: 0,
      startedAt,
      phaseChangedAt: startedAt,
      updatedAt: startedAt,
      workerHost: this.config.workerHost,
      workspacePath,
      tokens: emptyTokens(),
      recentEvents: [],
    }
    onRuntime(runtime)

    // A dispatch snapshot can become stale while a workspace is prepared or a
    // replacement plugin process is starting.  Validate the source before we
    // create/resume a conversation so an inactive card cannot receive a new
    // worker session.
    const initial = (await source.getIssuesByNativeRefs([issue.nativeRef], signal))[0]
    const initialResult = classifyRefreshedIssue(initial, workflow, runtime)
    if (initialResult !== undefined) return initialResult

    let handle: AgentHandle | undefined
    let removeEventListener: (() => void) | undefined
    const onAbort = (): void => {
      const reason = signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? 'unknown lifecycle reason')
      handle?.agent.cancel({ kind: 'hook', reason: `dsh-dashboard orchestration cancelled: ${reason}` })
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      const permissionPreset = request.lifecycle?.permissionPreset ?? this.config.permissionPreset
      this.ctx.permissionPresets.resolve(permissionPreset)
      const setup = async (agentCtx: Context): Promise<void> => {
        if (presets !== undefined) await presets.mount(agentCtx, resolvedPreset?.id)
        installModelSelection(agentCtx, selected)
        this.installTaskSourceTool(agentCtx, source, request)
      }
      handle = resumed
        ? await this.ctx.agents.resume({
            resumeSessionId: sessionId,
            agentOptions: { provider: selection.provider, model: selection.model },
            signal,
            setup,
          })
        : await this.ctx.agents.create({
            sessionId,
            meta: {
              cwd: workspacePath,
              ...(resolvedPreset === undefined ? {} : { agentPreset: resolvedPreset.id }),
            },
            agentOptions: { provider: selection.provider, model: selection.model },
            signal,
            setup,
          })
      if (!resumed) await request.onSessionBound(sessionId)
      this.ctx.permissionPresets.set(handle.agent.session, permissionPreset)
      await this.ctx.sessions.flush(handle.agent.session)
      const taskWorkspace = await this.ctx.workspaceRegistry.create(workspacePath, `${issue.scopeRef} · ${issue.identifier}`)
      await taskWorkspace.attachSession(sessionId)
      const completedTurns = sessionTurnCount(handle.agent.session.events)
      removeEventListener = this.ctx.on('session/event', (session, event) => {
        if (session.id !== sessionId) return
        runtime = projectEvent(runtime, event, completedTurns)
        onRuntime(runtime)
      })
      await handle.agent.whenIdle()

      const maxTurns = request.lifecycle?.maxTurns ?? workflow.agent.max_turns
      for (let turn = completedTurns + 1; turn <= maxTurns; turn += 1) {
        if (signal.aborted) throw signal.reason
        // Re-read immediately before every prompt.  The post-turn read below
        // is not sufficient: the card can leave an active state during the
        // delay between turns or while a resumed Agent is becoming idle.
        const current = (await source.getIssuesByNativeRefs([issue.nativeRef], signal))[0]
        const currentResult = classifyRefreshedIssue(current, workflow, runtime)
        if (currentResult !== undefined) return currentResult
        const prompt = turn === 1 && !resumed
          ? lifecyclePrompt(request.lifecycle, await renderIssuePrompt(workflow.prompt, { issue, attempt }))
          : continuationPrompt(turn, maxTurns)
        this.ctx.logger.info(
          'dsh-dashboard: model input issue=%s turn=%d/%d chars=%d sha256=%s',
          issue.identifier,
          turn,
          maxTurns,
          prompt.length,
          promptFingerprint(prompt),
        )
        const firstSeq = handle.agent.session.seq
        handle.agent.followup(createUserMessage({
          content: [{ type: 'text', text: prompt }],
          source: { kind: 'user' },
        }))
        await handle.agent.whenIdle()
        await this.ctx.sessions.flush(handle.agent.session)
        const end = lastTurnEnd(handle.agent.session.events, firstSeq)
        if (end?.data.reason.kind === 'error') {
          throw new Error(`${end.data.reason.error.code}: ${end.data.reason.error.message}`)
        }
        if (end?.data.reason.kind === 'blocked') {
          throw new AgentBlockedError(`Harness Agent reported a blocked turn for ${issue.identifier}`)
        }
        if (end?.data.reason.kind !== 'completed') {
          throw new Error(`Harness Agent turn ended as ${end?.data.reason.kind ?? 'unknown'}`)
        }

        const refreshed = (await source.getIssuesByNativeRefs([issue.nativeRef], signal))[0]
        const refreshedResult = classifyRefreshedIssue(refreshed, workflow, runtime)
        if (refreshedResult !== undefined) return withHandoff(refreshedResult)
        runtime = { ...runtime, state: refreshed!.state.name, updatedAt: new Date().toISOString() }
        onRuntime(runtime)
        if (turn < maxTurns) await abortableDelay(1000, signal)
      }
      return withHandoff({ kind: 'exhausted', issue, runtime })
    } finally {
      signal.removeEventListener('abort', onAbort)
      removeEventListener?.()
      if (handle !== undefined) {
        try {
          await this.ctx.sessions.flush(handle.agent.session)
        } finally {
          await handle.dispose()
        }
      }
    }
  }

  private installTaskSourceTool(agentCtx: Context, source: TaskSource, request: AgentRunRequest): void {
    const tool = resolveTaskSourceAgentTool(source)
    if (tool === undefined) return
    const tools = agentCtx.get('tools')
    if (tools === undefined) throw new Error('dsh-dashboard: ctx.tools is unavailable in the Agent scope')
    if (tool.kind === 'graphql') {
      tools.register(defineTool({
        name: tool.name,
        description: tool.description,
        parameters: {
          query: { type: 'string', required: true, description: 'GraphQL query or mutation document.' },
          variables: { type: 'object', additionalProperties: true, description: 'Optional GraphQL variables object.' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute(args, exec) {
          return await tool.execute(args.query, args.variables ?? {}, exec.signal) as never
        },
      }))
      return
    }
    if (tool.kind === 'rest') {
      tools.register(defineTool({
        name: tool.name,
        description: tool.description,
        parameters: {
          method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], required: true },
          path: { type: 'string', required: true, description: 'Provider-relative API path without an origin.' },
          query: { type: 'object', additionalProperties: true, description: 'Optional query parameters.' },
          body: { type: 'json', description: 'Optional lossless-JSON request body.' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute(args, exec) {
          return await tool.execute({
            method: args.method,
            path: args.path,
            ...(args.query === undefined ? {} : { query: args.query }),
            ...(args.body === undefined ? {} : { body: args.body }),
          }, exec.signal) as never
        },
      }))
      return
    }
    tools.register(defineTool({
      name: tool.name,
      description: tool.description,
      parameters: {
        operation: { type: 'string', enum: ['get', 'update', 'record-user-test-evidence'], required: true },
        nativeRef: { type: 'string', required: true },
        title: { type: 'string' },
        description: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        state: { type: 'string' },
        priority: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
        evidence: { type: 'json', description: 'Structured exact-commit evidence patch; required for record-user-test-evidence.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        if (args.nativeRef !== request.issue.nativeRef) {
          throw new Error(`task tool is scoped to ${request.issue.nativeRef}; cross-task access is forbidden`)
        }
        const evidence = args.evidence === undefined ? undefined : parseUserTestEvidencePatch(args.evidence)
        if (typeof evidence === 'string') throw new Error(`invalid User Test evidence: ${evidence}`)
        if (args.operation === 'record-user-test-evidence') {
          if (evidence === undefined) throw new Error('record-user-test-evidence requires evidence')
          const role = request.lifecycle?.role
          if (role !== 'qa' && role !== 'review' && role !== 'delivery') {
            throw new Error(`lifecycle role ${role ?? 'legacy'} is not authorized to record User Test evidence`)
          }
          if (source.recordUserTestEvidence === undefined) throw new Error('task source does not support User Test evidence')
          const workspaceSha = await cleanWorkspaceHead(request.workspacePath, exec.signal)
          if (workspaceSha !== evidence.commitSha) {
            throw new Error(`evidence commit ${evidence.commitSha} does not match host-derived workspace HEAD ${workspaceSha}`)
          }
          return await source.recordUserTestEvidence(args.nativeRef, evidence, { role, workspaceSha }, exec.signal) as never
        }
        return await tool.execute({
          operation: args.operation,
          nativeRef: args.nativeRef,
          ...(args.title === undefined ? {} : { title: args.title }),
          ...(args.description === undefined ? {} : { description: args.description }),
          ...(args.state === undefined ? {} : { state: args.state }),
          ...(args.priority === undefined ? {} : { priority: args.priority }),
          ...(evidence === undefined ? {} : { evidence }),
        }, exec.signal) as never
      },
    }))
  }
}

/** Resolve evidence identity only when every index/worktree/submodule byte is committed. */
export async function cleanWorkspaceHead(workspacePath: string, signal?: AbortSignal): Promise<string> {
  const options = { encoding: 'utf8' as const, ...(signal === undefined ? {} : { signal }) }
  const { stdout: status } = await execFileAsync('git', [
    '-C', workspacePath, 'status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none',
  ], options)
  if (status.trim() !== '') {
    throw new Error('User Test evidence requires a clean index, worktree, untracked-file set, and submodule state')
  }
  const { stdout } = await execFileAsync('git', ['-C', workspacePath, 'rev-parse', 'HEAD'], options)
  const head = stdout.trim()
  if (!/^[0-9a-f]{40}$/u.test(head)) throw new Error(`workspace HEAD is not a full Git SHA: ${head}`)
  return head
}

function classifyRefreshedIssue(
  issue: TaskIssue | undefined,
  workflow: WorkflowDefinition,
  runtime: IssueRuntimeView,
): AgentRunResult | undefined {
  if (issue === undefined) return { kind: 'inactive', runtime }
  const state = normalizedState(issue.state.name)
  const projected = { ...runtime, state: issue.state.name, updatedAt: new Date().toISOString() }
  if (workflow.tracker.terminal_states.map(normalizedState).includes(state)) {
    return { kind: 'terminal', issue, runtime: projected }
  }
  if (!workflow.tracker.active_states.map(normalizedState).includes(state)) {
    return { kind: 'inactive', issue, runtime: projected }
  }
  return undefined
}

export class AgentBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentBlockedError'
  }
}

function projectEvent(current: IssueRuntimeView, event: SessionEvent, turnOffset = 0): IssueRuntimeView {
  const at = new Date(event.time).toISOString()
  let tokens = current.tokens
  let lastMessage = current.lastMessage
  let title: string = event.type
  let detail: string | undefined
  let turnCount = current.turnCount
  if (event.type === 'turn/start') {
    title = 'Turn started'
    detail = `Turn ${event.data.turn} started`
    turnCount = Math.max(turnCount, event.data.turn - turnOffset)
  } else if (event.type === 'assistant/message') {
    title = 'Assistant message'
    const text = event.data.message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
      .trim()
    if (text !== '') {
      lastMessage = text
      detail = text.length > 220 ? `${text.slice(0, 220)}…` : text
    }
    if (event.data.usage !== undefined) tokens = addUsage(tokens, event.data.usage)
  } else if (event.type === 'tool/call') {
    title = 'Tool started'
    detail = event.data.name
  } else if (event.type === 'tool/result') {
    title = 'Tool completed'
  } else if (event.type === 'turn/end') {
    title = 'Turn ended'
    detail = event.data.reason.kind
  }
  const recent: RuntimeEventView = {
    id: `session:${String(current.sessionId)}:${event.seq}`,
    type: event.type,
    title,
    ...(detail === undefined ? {} : { detail }),
    at,
  }
  return {
    ...current,
    turnCount,
    updatedAt: at,
    lastEvent: event.type,
    ...(lastMessage === undefined ? {} : { lastMessage }),
    lastEventAt: at,
    tokens,
    recentEvents: [recent, ...current.recentEvents].slice(0, 12),
  }
}

function addUsage(current: TokenTotals, usage: TokenUsage): TokenTotals {
  const input = usage.inputTokens
  const output = usage.outputTokens
  const cacheRead = usage.cacheReadTokens ?? 0
  const cacheWrite = usage.cacheWriteTokens ?? 0
  const reasoning = usage.reasoningTokens ?? 0
  return {
    input: current.input + input,
    output: current.output + output,
    cacheRead: current.cacheRead + cacheRead,
    cacheWrite: current.cacheWrite + cacheWrite,
    reasoning: current.reasoning + reasoning,
    total: current.total + input + output + cacheRead + cacheWrite,
  }
}

function lastTurnEnd(events: readonly SessionEvent[], firstSeq: number): SessionEvent<'turn/end'> | undefined {
  return events.filter((event): event is SessionEvent<'turn/end'> => event.seq >= firstSeq && event.type === 'turn/end').at(-1)
}

function sessionTurnCount(events: readonly SessionEvent[]): number {
  return events.reduce((maximum, event) => event.type === 'turn/start' ? Math.max(maximum, event.data.turn) : maximum, 0)
}

function continuationPrompt(turn: number, maxTurns: number): string {
  return [
    'Continue working on the current issue from the existing workspace and conversation state.',
    `This is continuation turn #${turn} of ${maxTurns}.`,
    'Do not repeat completed investigation. Re-read the tracker state, continue implementation and validation, and keep the issue workpad current.',
    'Only stop early for a true external blocker or when the issue has left an active state.',
  ].join('\n')
}

function lifecyclePrompt(lifecycle: AgentRunRequest['lifecycle'], base: string): string {
  if (lifecycle === undefined) return base
  return [
    base,
    `Dashboard lifecycle role: ${lifecycle.role}.`,
    lifecycle.instruction ?? '',
    lifecycle.handoff === undefined ? '' : `Compact prior-role handoff:\n${lifecycle.handoff}`,
  ].filter(Boolean).join('\n\n')
}

function withHandoff(result: Omit<AgentRunResult, 'handoff'>): AgentRunResult {
  return {
    ...result,
    ...(result.runtime.lastMessage === undefined ? {} : { handoff: result.runtime.lastMessage }),
  }
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((accept, reject) => {
    const finish = (): void => {
      signal.removeEventListener('abort', onAbort)
      accept()
    }
    const timer = setTimeout(finish, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}
