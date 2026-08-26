import { describe, expect, it } from 'vitest'
import { DEFAULT_LIFECYCLE_POLICY, resolveLifecyclePipeline, resolveLifecycleRoute } from '../src/lifecycle/policy.ts'
import { parseWorkflow } from '../src/workflow/parser.ts'

const options = {
  defaults: { pollingIntervalMs: 5000, workspaceRoot: '/workspace', hookTimeoutMs: 60_000, maxConcurrentAgents: 1, maxTurns: 20, maxRetryBackoffMs: 60_000 },
  lifecycleDefaults: DEFAULT_LIFECYCLE_POLICY,
  agentProfile: { id: 'default', permissionPreset: 'workspace-write', workerHost: 'test' },
}

describe('lifecycle model routing policy', () => {
  it('resolves per-project Claude role routes without hardcoding a project', () => {
    const workflow = parseWorkflow(`---
version: 1
project: { name: generic, agent_profile: default }
tracker:
  kind: local
  provider: { project_id: generic }
  active_states: [Ready]
  terminal_states: [Done]
policy:
  lifecycle:
    enabled: true
    roles:
      planning: { provider: claude-code-worker, model: claude-opus-5, reasoning_effort: high, fallback_model: claude-sonnet-5, fallback_reasoning_effort: high, fallback_after_failures: 1, permission_preset: read-only, max_turns: 1 }
      implementation: { provider: claude-code-worker, model: claude-sonnet-5, reasoning_effort: medium, permission_preset: workspace-write }
      delivery: { provider: claude-code-worker, model: claude-sonnet-5, reasoning_effort: medium, permission_preset: workspace-write }
---
Work the task.`, '/tmp/WORKFLOW.md', options)

    expect(workflow.lifecycle?.enabled).toBe(true)
    expect(workflow.lifecycle?.roles.planning).toMatchObject({ model: 'claude-opus-5', fallback_model: 'claude-sonnet-5', permission_preset: 'read-only' })
    expect(workflow.lifecycle?.roles.implementation).toMatchObject({ model: 'claude-sonnet-5', permission_preset: 'workspace-write' })
    expect(workflow.lifecycle?.roles.delivery).toMatchObject({ model: 'claude-sonnet-5', permission_preset: 'workspace-write' })
  })

  it('keeps the preferred route until its explicit failure fallback activates', () => {
    const route = {
      provider: 'claude-code-worker', model: 'claude-opus-5', reasoning_effort: 'high' as const,
      fallback_model: 'claude-sonnet-5', fallback_reasoning_effort: 'medium' as const,
      fallback_after_failures: 1, permission_preset: 'read-only', max_turns: 2,
    }
    expect(resolveLifecycleRoute(route, 0).model).toBe('claude-opus-5')
    expect(resolveLifecycleRoute(route, 1)).toMatchObject({
      provider: 'claude-code-worker', model: 'claude-sonnet-5', reasoning_effort: 'medium',
      permission_preset: 'read-only', max_turns: 2,
    })
  })

  it('inserts an Opus escalation before a writer after repeated failures and promotes high-risk reviews', () => {
    const policy = { ...DEFAULT_LIFECYCLE_POLICY, enabled: true, state_roles: { ready: ['implementation'] as const, review: ['review'] as const } }
    expect(resolveLifecyclePipeline(policy, 'Ready', [], 2)).toEqual(['escalation', 'implementation'])
    expect(resolveLifecyclePipeline(policy, 'Review', ['security'], 0)).toEqual(['escalation', 'review'])
    expect(resolveLifecyclePipeline({ ...policy, state_roles: {} }, 'Unconfigured', [], 0)).toEqual(['planning', 'implementation', 'qa'])
  })

  it('routes mixed-case configured state roles through the canonical state key', () => {
    const workflow = parseWorkflow(`---
version: 1
project: { name: generic, agent_profile: default }
tracker:
  kind: local
  provider: { project_id: generic }
  active_states: [Ready]
  terminal_states: [Done]
policy:
  lifecycle:
    enabled: true
    state_roles:
      " Ready ": [implementation, qa]
---
Work the task.`, '/tmp/WORKFLOW.md', options)

    expect(workflow.lifecycle?.state_roles).toEqual({ ready: ['implementation', 'qa'] })
    expect(resolveLifecyclePipeline(workflow.lifecycle!, 'READY', [], 0)).toEqual(['implementation', 'qa'])
  })

  it('applies target-state role routes to legacy provider cards during migration', () => {
    const policy = { ...DEFAULT_LIFECYCLE_POLICY, enabled: true, state_roles: { implementing: ['implementation', 'qa'] as const } }
    expect(resolveLifecyclePipeline(policy, 'Working', [], 0)).toEqual(['implementation', 'qa'])
  })
})
