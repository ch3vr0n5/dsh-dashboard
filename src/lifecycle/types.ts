/** Explicit, durable model/permission routing for Dashboard task phases. */

export const lifecycleRoles = ['planning', 'implementation', 'qa', 'review', 'escalation'] as const
export type LifecycleRole = (typeof lifecycleRoles)[number]

export interface LifecycleRoute {
  /** Harness provider route. Omit to inherit the user's selected default. */
  readonly provider?: string
  /** Provider model id. Omit to inherit the user's selected default. */
  readonly model?: string
  /** Provider-supported reasoning effort. */
  readonly reasoning_effort?: 'low' | 'medium' | 'high' | 'xhigh'
  /** Optional provider used after the configured failure threshold. */
  readonly fallback_provider?: string
  /** Optional model used after the configured failure threshold. */
  readonly fallback_model?: string
  /** Optional reasoning effort used with the fallback route. */
  readonly fallback_reasoning_effort?: 'low' | 'medium' | 'high' | 'xhigh'
  /** Dashboard attempt count that activates the fallback route. Defaults to one. */
  readonly fallback_after_failures?: number
  /** Permission preset pinned into the role-owned session. */
  readonly permission_preset: string
  /** Role-local maximum turns; implementation may use the task default. */
  readonly max_turns?: number
}

export interface LifecyclePolicy {
  readonly enabled: boolean
  /** Ordered phase list for a state. State keys are case-insensitive. */
  readonly state_roles: Readonly<Record<string, readonly LifecycleRole[]>>
  readonly roles: Readonly<Record<LifecycleRole, LifecycleRoute>>
  /** Insert an Opus escalation analysis before unfinished work after this many failed attempts. */
  readonly escalate_after_failures: number
  /** Labels that cause a requested review to use the escalation/high-risk route. */
  readonly high_risk_labels: readonly string[]
}

export interface LifecycleSessionRecord {
  readonly projectId: string
  readonly issueKey: string
  readonly role: LifecycleRole
  /** Stable identity for one role attempt; absent only on legacy records. */
  readonly attemptId?: string
  readonly sessionId?: string
  readonly status: 'running' | 'completed' | 'failed'
  readonly issueRevision: string
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
  readonly permissionPreset: string
  readonly startedAt: string
  readonly updatedAt: string
  readonly finishedAt?: string
  readonly runtimeMs?: number
  readonly tokens: {
    readonly input: number
    readonly output: number
    readonly cacheRead: number
    readonly cacheWrite: number
    readonly reasoning: number
    readonly total: number
  }
  /** Compact, role-produced context for the next role; never a full transcript. */
  readonly handoff?: string
  readonly error?: string
}

export interface LifecycleSessionView extends LifecycleSessionRecord {}
