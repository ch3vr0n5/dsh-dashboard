import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { HarnessAgentRunner } from '../src/agent/harness-runner.ts'
import type { TaskIssue } from '../src/domain/issue.ts'
import type { TaskSource } from '../src/task-source/index.ts'
import type { WorkflowDefinition } from '../src/workflow/types.ts'

describe('HarnessAgentRunner card-owned sessions', () => {
  it('persists a new session before sending the first task prompt', async () => {
    const order: string[] = []
    const handle = fakeHandle([], order)
    const create = vi.fn(async () => { order.push('create'); return handle })
    const resume = vi.fn()
    const runner = new HarnessAgentRunner(context(create, resume, order), runnerConfig)

    const result = await runner.run(request({
      onSessionBound: async () => { order.push('bound') },
    }))

    expect(result.kind).toBe('inactive')
    expect(create).toHaveBeenCalledOnce()
    expect(resume).not.toHaveBeenCalled()
    expect(order.slice(0, 6)).toEqual(['create', 'bound', 'workspace', 'attached', 'followup', 'turn'])
  })

  it('resumes the bound session with a continuation instead of reseeding the task', async () => {
    const prior = abortedTurn(1)
    const prompts: string[] = []
    const handle = fakeHandle(prior, [], prompts)
    const create = vi.fn()
    const resume = vi.fn(async () => handle)
    const onSessionBound = vi.fn(async () => {})
    const runner = new HarnessAgentRunner(context(create, resume), runnerConfig)

    const result = await runner.run(request({
      sessionId: SessionId('dsh-dashboard-card-session'),
      onSessionBound,
    }))

    expect(result.kind).toBe('inactive')
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ resumeSessionId: 'dsh-dashboard-card-session' }))
    expect(create).not.toHaveBeenCalled()
    expect(onSessionBound).not.toHaveBeenCalled()
    expect(prompts[0]).toContain('continuation turn #2 of 3')
    expect(prompts[0]).not.toContain('Full original task prompt')
  })

  it('enforces max_turns cumulatively across resumed processes', async () => {
    const prompts: string[] = []
    const handle = fakeHandle([...completedTurn(1), ...completedTurn(2, 2), ...completedTurn(3, 4)], [], prompts)
    const runner = new HarnessAgentRunner(context(vi.fn(), vi.fn(async () => handle)), runnerConfig)

    const result = await runner.run(request({
      sessionId: SessionId('dsh-dashboard-card-session'),
      onSessionBound: vi.fn(async () => {}),
    }))

    expect(result.kind).toBe('exhausted')
    expect(prompts).toEqual([])
  })

  it('records the concrete orchestration cancellation cause in the session ending', async () => {
    const abort = new AbortController()
    const cancel = vi.fn()
    const handle = fakeHandle([])
    handle.agent.cancel = cancel
    handle.agent.whenIdle = vi.fn(async () => { abort.abort(new Error('dsh-dashboard plugin disposed')) })
    const runner = new HarnessAgentRunner(context(vi.fn(async () => handle), vi.fn()), runnerConfig)

    await expect(runner.run(request({ signal: abort.signal }))).rejects.toThrow('dsh-dashboard plugin disposed')
    expect(cancel).toHaveBeenCalledWith({
      kind: 'hook',
      reason: 'dsh-dashboard orchestration cancelled: dsh-dashboard plugin disposed',
    })
  })

  it('pins an explicit lifecycle role model and permission into its own session', async () => {
    const create = vi.fn(async () => fakeHandle([]))
    const permissions = { resolve: vi.fn(), set: vi.fn() }
    const runner = new HarnessAgentRunner(context(create, vi.fn(), [], permissions), runnerConfig)

    await runner.run(request({
      lifecycle: { role: 'planning', provider: 'claude-code-worker', model: 'claude-opus-5', permissionPreset: 'read-only', maxTurns: 1 },
    }))

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ agentOptions: { provider: 'claude-code-worker', model: 'claude-opus-5' } }))
    expect(permissions.set).toHaveBeenCalledWith(expect.anything(), 'read-only')
  })

  it('does not create or resume a session when the source card is already inactive', async () => {
    const create = vi.fn()
    const resume = vi.fn()
    const runner = new HarnessAgentRunner(context(create, resume), runnerConfig)

    const result = await runner.run(request({
      source: taskSource(() => issue('User Test')),
    }))

    expect(result).toMatchObject({ kind: 'inactive', issue: { state: { name: 'User Test' } } })
    expect(create).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()
  })

  it('re-reads the source before a continuation and does not send a second prompt after the card leaves an active state', async () => {
    const prompts: string[] = []
    const create = vi.fn(async () => fakeHandle([], [], prompts))
    const runner = new HarnessAgentRunner(context(create, vi.fn()), runnerConfig)
    let reads = 0

    const result = await runner.run(request({
      source: taskSource(() => issue(++reads >= 4 ? 'User Test' : 'Todo')),
    }))

    expect(result).toMatchObject({ kind: 'inactive', issue: { state: { name: 'User Test' } } })
    expect(prompts).toHaveLength(1)
    expect(reads).toBe(4)
  })
})

function context(create: ReturnType<typeof vi.fn>, resume: ReturnType<typeof vi.fn>, order: string[] = [], permissions = { resolve: vi.fn(), set: vi.fn() }): Context {
  const attachSession = vi.fn(async () => { order.push('attached') })
  return {
    agents: { create, resume },
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test-model' }) },
    permissionPresets: permissions,
    sessions: { flush: vi.fn(async () => {}) },
    workspaceRegistry: { create: vi.fn(async () => { order.push('workspace'); return { attachSession } }) },
    logger: { info: vi.fn(), warn: vi.fn() },
    get: () => undefined,
    on: () => () => {},
  } as unknown as Context
}

function fakeHandle(seed: readonly SessionEvent[], order: string[] = [], prompts: string[] = []): AgentHandle {
  const events = [...seed]
  let pending = false
  const session = {
    id: SessionId('dsh-dashboard-card-session'),
    get seq() { return events.length },
    get events() { return events },
  }
  return {
    agent: {
      session,
      followup: (message: { content: readonly { type: string; text?: string }[] }) => {
        order.push('followup')
        prompts.push(message.content.filter(block => block.type === 'text').map(block => block.text ?? '').join(''))
        pending = true
      },
      whenIdle: async () => {
        if (!pending) return
        order.push('turn')
        pending = false
        const turn = Math.max(0, ...events.filter(event => event.type === 'turn/start').map(event => event.data.turn)) + 1
        events.push(...completedTurn(turn, events.length))
      },
      cancel: vi.fn(),
    },
    dispose: vi.fn(async () => {}),
  } as unknown as AgentHandle
}

function completedTurn(turn: number, seq = 0): SessionEvent[] {
  return [
    { type: 'turn/start', seq, time: seq, data: { turn } },
    { type: 'turn/end', seq: seq + 1, time: seq + 1, data: { turn, reason: { kind: 'completed' } } },
  ] as SessionEvent[]
}

function abortedTurn(turn: number, seq = 0): SessionEvent[] {
  return [
    { type: 'turn/start', seq, time: seq, data: { turn } },
    {
      type: 'turn/end',
      seq: seq + 1,
      time: seq + 1,
      data: { turn, reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'plugin restarted' } } },
    },
  ] as SessionEvent[]
}

function request(overrides: Partial<Parameters<HarnessAgentRunner['run']>[0]> = {}): Parameters<HarnessAgentRunner['run']>[0] {
  return {
    issue: issue('Todo'),
    source: oneTurnSource(),
    workflow,
    workspacePath: '/workspace/task',
    attempt: 0,
    signal: new AbortController().signal,
    onRuntime: () => {},
    onSessionBound: async () => {},
    ...overrides,
  }
}

function issue(state: string): TaskIssue {
  return {
    sourceKind: 'local', scopeRef: 'demo', nativeRef: 'issue-1', identifier: 'LOCAL-1',
    title: 'Full original task prompt', state: { name: state }, labels: [], blockedBy: [], dispatchable: true,
  }
}

function oneTurnSource(): TaskSource {
  let reads = 0
  return taskSource(() => issue(++reads >= 3 ? 'User Test' : 'Todo'))
}

function taskSource(current: () => TaskIssue): TaskSource {
  return {
    kind: 'local',
    context: () => ({ kind: 'local', providerLabel: 'Local', projectLabel: 'demo', projectRef: 'demo' }),
    listBoardIssues: async () => [],
    listIssuesByStates: async () => [],
    getIssuesByNativeRefs: async () => [current()],
  }
}

const workflow: WorkflowDefinition = {
  version: 1,
  project: { name: 'demo', agent_profile: 'default' },
  tracker: { kind: 'local', provider: { project_id: 'demo' }, required_labels: [], active_states: ['Todo'], terminal_states: ['Done'] },
  polling: { interval_ms: 5000 },
  workspace: { root: '/workspace' },
  hooks: { timeout_ms: 10_000 },
  agent: { max_concurrent_agents: 1, max_concurrent_agents_by_state: {}, max_turns: 3, max_retry_backoff_ms: 60_000 },
  dashboard: { visible_states: [] },
  prompt: '{{ issue.title }}',
  sourcePath: 'WORKFLOW.md',
  loadedAt: '2026-08-25T00:00:00.000Z',
}

const runnerConfig = { permissionPreset: 'workspace-write', workerHost: 'test' }
