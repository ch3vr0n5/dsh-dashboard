import type { LifecyclePolicy, LifecycleRole, LifecycleRoute } from './types.ts'

export const DEFAULT_LIFECYCLE_ROUTES: Readonly<Record<LifecycleRole, LifecycleRoute>> = {
  planning: { permission_preset: 'read-only', max_turns: 2 },
  implementation: { permission_preset: 'workspace-write' },
  qa: { permission_preset: 'workspace-write', max_turns: 3 },
  review: { permission_preset: 'read-only', max_turns: 2 },
  escalation: { permission_preset: 'read-only', max_turns: 2 },
}

export const DEFAULT_LIFECYCLE_POLICY: LifecyclePolicy = {
  enabled: false,
  state_roles: {},
  roles: DEFAULT_LIFECYCLE_ROUTES,
  escalate_after_failures: 2,
  high_risk_labels: ['security', 'high-risk', 'architecture'],
}

export function resolveLifecyclePipeline(
  policy: LifecyclePolicy,
  state: string,
  labels: readonly string[],
  failureCount: number,
): readonly LifecycleRole[] {
  if (!policy.enabled) return ['implementation']
  const requested = policy.state_roles[normalize(state)] ?? ['planning', 'implementation', 'qa']
  const highRisk = new Set(policy.high_risk_labels.map(normalize))
  const routed = requested.map(role => role === 'review' && labels.some(label => highRisk.has(normalize(label))) ? 'escalation' : role)
  if (failureCount >= policy.escalate_after_failures && !routed.includes('escalation')) {
    const writer = routed.findIndex(role => role === 'implementation' || role === 'qa')
    const insertAt = writer < 0 ? 0 : writer
    routed.splice(insertAt, 0, 'escalation')
  }
  return [...new Set(routed)]
}

export function normalize(value: string): string {
  return value.trim().toLocaleLowerCase('en-US')
}

export function rolePrompt(role: LifecycleRole): string {
  const common = [
    'This is one explicit Dashboard lifecycle role. Stay in the assigned workspace.',
    'Never merge, enable auto-merge, force-push, or modify another task workspace.',
    'Do not carry a full prior chat history: use any compact handoff as context and verify it against the repository.',
  ].join('\n\n')
  const instruction: Record<LifecycleRole, string> = {
    planning: 'Plan/architecture only. Inspect read-only evidence and finish with a compact handoff: scope, acceptance criteria, files likely affected, risks, and test plan. Do not edit files, mutate services, push, or change task state.',
    implementation: 'Implement the approved task. Make the smallest coherent change, run focused tests, commit and push the feature branch, and open or update its PR when requested by the project workflow. Do not merge and do not move the card to User Test; the QA role owns the test gate.',
    qa: 'Perform focused validation and repair only mechanical defects you can prove. Preserve scope, run tests, commit/push any repair to the same branch/PR, and report exact evidence. Do not merge. If the workflow requires a User Test transition after successful QA, perform it only when all acceptance criteria are verified.',
    review: 'Routine review only. Inspect the compact handoff and current diff. Do not edit files, mutate services, merge, or change the tracker. Return concise findings with severity and file/line evidence.',
    escalation: 'High-risk/repeated-failure analysis only. Inspect read-only evidence, diagnose the smallest safe path forward, and produce a compact handoff for implementation. Do not edit files, mutate services, merge, or change the tracker.',
  }
  return `${common}\n\n${instruction[role]}`
}

export function compactHandoff(value: string | undefined): string | undefined {
  const compact = value?.trim().replace(/\s+$/g, '')
  if (compact === undefined || compact === '') return undefined
  return compact.length <= 6000 ? compact : `${compact.slice(0, 5999)}…`
}
