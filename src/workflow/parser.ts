/** Breaking v1 project-policy frontmatter parser and layered resolver. */

import { load as loadYaml } from 'js-yaml'
import { z } from 'zod'
import type { AgentProfileConfig, PolicyDefaultsConfig } from '../config.ts'
import type { WorkflowDefinition } from './types.ts'
import { DEFAULT_LIFECYCLE_ROUTES } from '../lifecycle/policy.ts'
import type { LifecyclePolicy, LifecycleRole } from '../lifecycle/types.ts'
import { normalizedState } from '../domain/issue.ts'

const nonBlank = z.string().trim().min(1)

const lifecycleRouteSchema = z.object({
  provider: nonBlank.optional(),
  model: nonBlank.optional(),
  reasoning_effort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
  fallback_provider: nonBlank.optional(),
  fallback_model: nonBlank.optional(),
  fallback_reasoning_effort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
  fallback_after_failures: z.number().int().positive().optional(),
  permission_preset: nonBlank.optional(),
  max_turns: z.number().int().positive().optional(),
}).strict()

const schema = z.object({
  version: z.literal(1),
  project: z.object({
    name: nonBlank,
    agent_profile: nonBlank,
  }).strict(),
  tracker: z.object({
    kind: nonBlank,
    provider: z.record(z.string(), z.unknown()),
    required_labels: z.array(nonBlank).default([]),
    active_states: z.array(nonBlank).min(1),
    terminal_states: z.array(nonBlank).min(1),
  }).strict(),
  policy: z.object({
    polling: z.object({
      interval_ms: z.number().int().positive().optional(),
    }).strict().optional(),
    workspace: z.object({
      root: nonBlank.optional(),
    }).strict().optional(),
    hooks: z.object({
      after_create: z.string().min(1).optional(),
      before_run: z.string().min(1).optional(),
      after_run: z.string().min(1).optional(),
      before_remove: z.string().min(1).optional(),
      timeout_ms: z.number().int().positive().optional(),
    }).strict().optional(),
    agent: z.object({
      max_concurrent_agents: z.number().int().positive().optional(),
      max_concurrent_agents_by_state: z.record(z.string(), z.number().int().positive()).optional(),
      max_turns: z.number().int().positive().optional(),
      max_retry_backoff_ms: z.number().int().positive().optional(),
    }).strict().optional(),
    lifecycle: z.object({
      enabled: z.boolean().optional(),
      state_roles: z.record(z.string(), z.array(z.enum(['planning', 'implementation', 'qa', 'review', 'delivery', 'escalation']))).optional(),
      roles: z.object({
        planning: lifecycleRouteSchema.optional(),
        implementation: lifecycleRouteSchema.optional(),
        qa: lifecycleRouteSchema.optional(),
        review: lifecycleRouteSchema.optional(),
        delivery: lifecycleRouteSchema.optional(),
        escalation: lifecycleRouteSchema.optional(),
      }).strict().optional(),
      escalate_after_failures: z.number().int().positive().optional(),
      high_risk_labels: z.array(nonBlank).optional(),
    }).strict().optional(),
    dashboard: z.object({
      visible_states: z.array(nonBlank).optional(),
    }).strict().optional(),
  }).strict().default({}),
}).strict()

export interface WorkflowParseOptions {
  readonly defaults: PolicyDefaultsConfig
  readonly lifecycleDefaults?: LifecyclePolicy
  readonly agentProfile: AgentProfileConfig
}

/** Parse one v1 project policy and resolve global defaults plus its Agent Profile. */
export function parseWorkflow(
  text: string,
  sourcePath: string,
  options: WorkflowParseOptions,
  now = new Date(),
): WorkflowDefinition {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  if (!normalized.startsWith('---\n')) {
    throw new Error('WORKFLOW.md must start with a YAML frontmatter delimiter (`---`)')
  }
  const closing = normalized.indexOf('\n---\n', 4)
  if (closing < 0) {
    throw new Error('WORKFLOW.md is missing the closing YAML frontmatter delimiter (`---`)')
  }
  const frontmatterText = normalized.slice(4, closing)
  const prompt = normalized.slice(closing + 5).trim()
  if (prompt === '') throw new Error('WORKFLOW.md prompt body must not be empty')

  let document: unknown
  try {
    document = loadYaml(frontmatterText)
  } catch (error) {
    throw new Error(`WORKFLOW.md YAML is invalid: ${error instanceof Error ? error.message : String(error)}`)
  }
  const parsed = schema.safeParse(document)
  if (!parsed.success) {
    const message = parsed.error.issues
      .map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ')
    throw new Error(`WORKFLOW.md configuration is invalid: ${message}`)
  }
  const value = parsed.data
  if (value.project.agent_profile !== options.agentProfile.id) {
    throw new Error(
      `WORKFLOW.md project.agent_profile ${JSON.stringify(value.project.agent_profile)} is not configured; expected ${JSON.stringify(options.agentProfile.id)}`,
    )
  }
  const provider = normalizeProvider(value.tracker.kind, value.tracker.provider)
  return {
    version: 1,
    project: value.project,
    tracker: {
      kind: value.tracker.kind,
      provider,
      required_labels: value.tracker.required_labels,
      active_states: value.tracker.active_states,
      terminal_states: value.tracker.terminal_states,
    },
    polling: {
      interval_ms: value.policy.polling?.interval_ms ?? options.defaults.pollingIntervalMs,
    },
    workspace: {
      root: value.policy.workspace?.root ?? options.defaults.workspaceRoot,
    },
    hooks: {
      ...(value.policy.hooks?.after_create === undefined ? {} : { after_create: value.policy.hooks.after_create }),
      ...(value.policy.hooks?.before_run === undefined ? {} : { before_run: value.policy.hooks.before_run }),
      ...(value.policy.hooks?.after_run === undefined ? {} : { after_run: value.policy.hooks.after_run }),
      ...(value.policy.hooks?.before_remove === undefined ? {} : { before_remove: value.policy.hooks.before_remove }),
      timeout_ms: value.policy.hooks?.timeout_ms ?? options.defaults.hookTimeoutMs,
    },
    agent: {
      max_concurrent_agents: value.policy.agent?.max_concurrent_agents ?? options.defaults.maxConcurrentAgents,
      max_concurrent_agents_by_state: value.policy.agent?.max_concurrent_agents_by_state ?? {},
      max_turns: value.policy.agent?.max_turns ?? options.defaults.maxTurns,
      max_retry_backoff_ms: value.policy.agent?.max_retry_backoff_ms ?? options.defaults.maxRetryBackoffMs,
    },
    lifecycle: resolveLifecycle(value.policy.lifecycle, options.lifecycleDefaults ?? { enabled: false, state_roles: {}, roles: DEFAULT_LIFECYCLE_ROUTES, escalate_after_failures: 2, high_risk_labels: ['security', 'high-risk', 'architecture'] }),
    dashboard: {
      visible_states: value.policy.dashboard?.visible_states ?? [],
    },
    prompt,
    sourcePath,
    loadedAt: now.toISOString(),
  }
}

function resolveLifecycle(
  policy: z.infer<typeof schema>['policy']['lifecycle'],
  defaults: LifecyclePolicy,
): LifecyclePolicy {
  const configured = policy ?? {}
  const roles = {} as Record<LifecycleRole, LifecyclePolicy['roles'][LifecycleRole]>
  for (const role of ['planning', 'implementation', 'qa', 'review', 'delivery', 'escalation'] as const) {
    const merged = { ...DEFAULT_LIFECYCLE_ROUTES[role], ...defaults.roles[role], ...(configured.roles?.[role] ?? {}) }
    roles[role] = {
      ...(merged.provider === undefined ? {} : { provider: merged.provider }),
      ...(merged.model === undefined ? {} : { model: merged.model }),
      ...(merged.reasoning_effort === undefined ? {} : { reasoning_effort: merged.reasoning_effort }),
      ...(merged.fallback_provider === undefined ? {} : { fallback_provider: merged.fallback_provider }),
      ...(merged.fallback_model === undefined ? {} : { fallback_model: merged.fallback_model }),
      ...(merged.fallback_reasoning_effort === undefined ? {} : { fallback_reasoning_effort: merged.fallback_reasoning_effort }),
      ...(merged.fallback_after_failures === undefined ? {} : { fallback_after_failures: merged.fallback_after_failures }),
      permission_preset: merged.permission_preset ?? DEFAULT_LIFECYCLE_ROUTES[role].permission_preset,
      ...(merged.max_turns === undefined ? {} : { max_turns: merged.max_turns }),
    }
  }
  return {
    enabled: configured.enabled ?? defaults.enabled,
    state_roles: normalizeLifecycleStateRoles(configured.state_roles ?? defaults.state_roles),
    roles,
    escalate_after_failures: configured.escalate_after_failures ?? defaults.escalate_after_failures,
    high_risk_labels: configured.high_risk_labels ?? defaults.high_risk_labels,
  }
}

function normalizeLifecycleStateRoles(
  stateRoles: LifecyclePolicy['state_roles'],
): LifecyclePolicy['state_roles'] {
  const normalized: Record<string, readonly LifecycleRole[]> = {}
  const originalKeys = new Map<string, string>()
  for (const [state, roles] of Object.entries(stateRoles)) {
    const key = normalizedState(state)
    const previous = originalKeys.get(key)
    if (previous !== undefined) {
      throw new Error(
        `WORKFLOW.md configuration is invalid: policy.lifecycle.state_roles keys ${JSON.stringify(previous)} and ${JSON.stringify(state)} collide after normalization`,
      )
    }
    originalKeys.set(key, state)
    normalized[key] = roles
  }
  return normalized
}

function normalizeProvider(kindValue: string, value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const kind = kindValue.trim().toLocaleLowerCase('en-US')
  const provider = { ...value }
  if (kind === 'gitlab' && typeof provider.project_id === 'number') {
    if (!Number.isSafeInteger(provider.project_id) || provider.project_id <= 0) {
      throw new Error('WORKFLOW.md configuration is invalid: tracker.provider.project_id: expected a positive integer or non-empty string')
    }
    provider.project_id = String(provider.project_id)
  }
  const requiredByKind: Readonly<Record<string, readonly string[]>> = {
    linear: ['project_slug'],
    github: ['owner', 'repo'],
    jira: ['site_url', 'project_key'],
    asana: ['project_gid'],
    gitlab: ['project_id'],
  }
  for (const field of requiredByKind[kind] ?? []) {
    if (typeof provider[field] !== 'string' || provider[field].trim() === '') {
      throw new Error(`WORKFLOW.md configuration is invalid: tracker.provider.${field}: required for tracker kind ${kind}`)
    }
  }
  for (const field of ['context_label', 'assignee']) {
    const candidate = provider[field]
    if (candidate !== undefined && (typeof candidate !== 'string' || candidate.trim() === '')) {
      throw new Error(`WORKFLOW.md configuration is invalid: tracker.provider.${field}: expected a non-empty string`)
    }
  }
  if (provider.state_labels !== undefined && !isStringRecord(provider.state_labels)) {
    throw new Error('WORKFLOW.md configuration is invalid: tracker.provider.state_labels: expected a state-to-label string map')
  }
  if (kind === 'local' && (typeof provider.project_id !== 'string' || provider.project_id.trim() === '')) {
    provider.project_id = 'local'
  }
  return provider
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.entries(value).every(([key, item]) => key.trim() !== '' && typeof item === 'string' && item.trim() !== '')
}
