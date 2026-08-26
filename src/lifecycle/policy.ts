import type { LifecyclePolicy, LifecycleRole, LifecycleRoute } from './types.ts'

export const DEFAULT_LIFECYCLE_ROUTES: Readonly<Record<LifecycleRole, LifecycleRoute>> = {
  planning: { permission_preset: 'read-only', max_turns: 2 },
  implementation: { permission_preset: 'workspace-write' },
  qa: { permission_preset: 'workspace-write', max_turns: 3 },
  review: { permission_preset: 'read-only', max_turns: 2 },
  delivery: { permission_preset: 'workspace-write', max_turns: 3 },
  escalation: { permission_preset: 'read-only', max_turns: 2 },
}

export const DEFAULT_LIFECYCLE_POLICY: LifecyclePolicy = {
  enabled: false,
  state_roles: {},
  roles: DEFAULT_LIFECYCLE_ROUTES,
  escalate_after_failures: 2,
  high_risk_labels: ['security', 'high-risk', 'architecture'],
}

/** Select a role's preferred route until failures justify its explicit fallback. */
export function resolveLifecycleRoute(route: LifecycleRoute, failureCount: number): LifecycleRoute {
  const hasFallback = route.fallback_provider !== undefined
    || route.fallback_model !== undefined
    || route.fallback_reasoning_effort !== undefined
  if (!hasFallback || failureCount < (route.fallback_after_failures ?? 1)) return route
  return {
    ...(route.fallback_provider ?? route.provider) === undefined ? {} : { provider: route.fallback_provider ?? route.provider },
    ...(route.fallback_model ?? route.model) === undefined ? {} : { model: route.fallback_model ?? route.model },
    ...(route.fallback_reasoning_effort ?? route.reasoning_effort) === undefined
      ? {}
      : { reasoning_effort: route.fallback_reasoning_effort ?? route.reasoning_effort },
    permission_preset: route.permission_preset,
    ...(route.max_turns === undefined ? {} : { max_turns: route.max_turns }),
  }
}

export function resolveLifecyclePipeline(
  policy: LifecyclePolicy,
  state: string,
  labels: readonly string[],
  failureCount: number,
): readonly LifecycleRole[] {
  if (!policy.enabled) return ['implementation']
  // Preserve the pre-delivery fallback for existing version-1 workflows.
  // Delivery is an externally mutating role and must always be opted into by
  // an explicit state_roles entry.
  const requested = policy.state_roles[normalize(state)] ?? ['planning', 'implementation', 'qa']
  const highRisk = new Set(policy.high_risk_labels.map(normalize))
  const highRiskIssue = labels.some(label => highRisk.has(normalize(label)))
  // High-risk analysis supplements automated review; it never replaces the
  // review role that owns review evidence.
  const routed = requested.flatMap(role => role === 'review' && highRiskIssue ? ['escalation', 'review'] as const : [role])
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
    implementation: 'Implement the approved task. Make the smallest coherent change, run focused tests, and commit locally. Do not push, open or update a PR, deploy, merge, or move the card to User Test; automated QA and review must inspect this exact commit first.',
    qa: 'Run the required automated tests against the exact current commit and append structured automated-test evidence through the task tool. Repair only mechanical defects you can prove, but any repair creates a new commit that must be tested. Do not push, open or update a PR, deploy, merge, or move the card to User Test.',
    review: 'Perform automated review of the exact tested commit and append structured review evidence with the unresolved blocking-finding count through the task tool. Inspect the compact handoff and current diff. Do not edit files, mutate services, push, open or update a PR, deploy, merge, or change task state. Return concise findings with severity and file/line evidence.',
    delivery: 'Delivery only after structured automated-test and automated-review evidence passes for the exact current commit with zero unresolved blocking findings. Push and open or update the PR, read its exact head SHA, package and deploy that SHA, live-verify the running SHA and health URL, append each structured evidence component through the task tool, then request User Test. Never merge. If any commit changes, begin a new evidence attempt and repeat QA and review before PR/User Test.',
    escalation: 'High-risk/repeated-failure analysis only. Inspect read-only evidence, diagnose the smallest safe path forward, and produce a compact handoff for implementation. Do not edit files, mutate services, merge, or change the tracker.',
  }
  return `${common}\n\n${instruction[role]}`
}

export function compactHandoff(value: string | undefined): string | undefined {
  const compact = value?.trim().replace(/\s+$/g, '')
  if (compact === undefined || compact === '') return undefined
  return compact.length <= 6000 ? compact : `${compact.slice(0, 5999)}…`
}
