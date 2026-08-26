/** Read-only Dashboard projection for the reviewed control-plane/v1 contract.
 *
 * This module deliberately does not reconcile commands or authorize state
 * changes. Those operations belong to the reviewed external control plane.
 */

export const AUTONOMOUS_STATES = [
  'IDEA', 'TRIAGE', 'PLANNING', 'READY', 'CLAIMED', 'IMPLEMENTING',
  'LOCAL_QA', 'PR_OPEN', 'INDEPENDENT_REVIEW', 'REWORK', 'TEST_DEPLOYED',
  'ACCEPTANCE_QA', 'MERGE_READY', 'MERGED', 'DONE', 'RECOVERING',
  'PAUSED_CAPACITY', 'WAITING_HUMAN', 'FAILED_POLICY',
] as const

export type AutonomousState = (typeof AUTONOMOUS_STATES)[number]
export type AutonomousDomain = 'personal' | 'work'

export interface AutonomousEvidence {
  readonly headSha?: string
  readonly baseSha?: string
  readonly pullRequestUrl?: string
  readonly authorId?: string
  readonly reviewerId?: string
  readonly reviewId?: string
  readonly testDeploymentId?: string
  readonly acceptanceId?: string
  readonly reason?: string
}

/** Transport shape emitted by control-plane/v1; Dashboard only reads it. */
export interface ControlPlaneTaskEvent {
  readonly schemaVersion: 'control-plane/v1'
  readonly eventId: string
  readonly type: 'TASK_CREATED' | 'STATE_TRANSITIONED'
  readonly taskId: string
  readonly domain: AutonomousDomain
  readonly actor: { readonly id: string, readonly domain: AutonomousDomain }
  readonly occurredAt: string
  readonly payload: {
    readonly title?: string
    readonly initialState?: 'IDEA'
    readonly to?: AutonomousState
    readonly evidence?: AutonomousEvidence
  }
}

/** Read seam for the external append-only event store. It intentionally has no write method. */
export interface ControlPlaneReadAdapter {
  readTask(reference: ControlPlaneTaskReference, signal?: AbortSignal): Promise<ControlPlaneTaskRead | undefined>
}

export interface ControlPlaneTaskReference {
  readonly projectId: string
  /** Stable tracker-derived key, e.g. `local-42`. */
  readonly taskKey: string
  /** Human-readable, normalized title slug. */
  readonly taskSlug: string
  /** Default descriptive event-stream id: `${taskKey}-${taskSlug}`. */
  readonly taskId: string
  readonly domain: AutonomousDomain
}

export interface ControlPlaneTaskRead {
  readonly events: readonly ControlPlaneTaskEvent[]
}

export interface AutonomousLifecycleView {
  readonly source: 'control-plane' | 'legacy-alias'
  readonly taskKey: string
  readonly taskSlug: string
  readonly domain: AutonomousDomain
  readonly state: AutonomousState
  readonly currentRole: string
  readonly nextTransition?: AutonomousState
  readonly evidence: Required<AutonomousEvidence>
  readonly interrupt?: {
    readonly state: Extract<AutonomousState, 'RECOVERING' | 'PAUSED_CAPACITY' | 'WAITING_HUMAN' | 'FAILED_POLICY'>
    readonly resumesTo?: AutonomousState
    readonly recoveryAttempt?: number
    readonly reason?: string
    /** A human wait is explicit only for WAITING_HUMAN, never inferred from a pause. */
    readonly requiresHuman: boolean
  }
  /** Defensive read-model diagnostics; never used to authorize a transition. */
  readonly integrityWarnings?: readonly string[]
}

const aliases: Readonly<Record<string, AutonomousState>> = {
  backlog: 'IDEA', idea: 'IDEA',
  todo: 'TRIAGE', triage: 'TRIAGE',
  planning: 'PLANNING', ready: 'READY', claimed: 'CLAIMED',
  working: 'IMPLEMENTING', 'in progress': 'IMPLEMENTING', implementing: 'IMPLEMENTING',
  'local qa': 'LOCAL_QA', qa: 'LOCAL_QA',
  'pr open': 'PR_OPEN', review: 'INDEPENDENT_REVIEW', 'human review': 'INDEPENDENT_REVIEW', 'independent review': 'INDEPENDENT_REVIEW',
  rework: 'REWORK', 'test deployed': 'TEST_DEPLOYED',
  'user test': 'ACCEPTANCE_QA', 'acceptance qa': 'ACCEPTANCE_QA',
  merging: 'MERGE_READY', 'merge ready': 'MERGE_READY', merged: 'MERGED',
  done: 'DONE', recovering: 'RECOVERING', 'paused capacity': 'PAUSED_CAPACITY',
  'waiting human': 'WAITING_HUMAN', 'failed policy': 'FAILED_POLICY',
}

const normalTransitions: Readonly<Record<AutonomousState, AutonomousState | undefined>> = {
  IDEA: 'TRIAGE', TRIAGE: 'PLANNING', PLANNING: 'READY', READY: 'CLAIMED', CLAIMED: 'IMPLEMENTING',
  IMPLEMENTING: 'LOCAL_QA', LOCAL_QA: 'PR_OPEN', PR_OPEN: 'INDEPENDENT_REVIEW',
  INDEPENDENT_REVIEW: 'TEST_DEPLOYED', REWORK: 'IMPLEMENTING', TEST_DEPLOYED: 'ACCEPTANCE_QA',
  ACCEPTANCE_QA: 'MERGE_READY', MERGE_READY: 'MERGED', MERGED: 'DONE', DONE: undefined,
  RECOVERING: undefined, PAUSED_CAPACITY: undefined, WAITING_HUMAN: undefined, FAILED_POLICY: 'TRIAGE',
}

const roleByState: Readonly<Record<AutonomousState, string>> = {
  IDEA: 'intake', TRIAGE: 'triage', PLANNING: 'planner', READY: 'admission', CLAIMED: 'claim-owner',
  IMPLEMENTING: 'implementation', LOCAL_QA: 'local-qa', PR_OPEN: 'delivery', INDEPENDENT_REVIEW: 'independent-reviewer',
  REWORK: 'implementation', TEST_DEPLOYED: 'deployment', ACCEPTANCE_QA: 'acceptance-qa',
  MERGE_READY: 'merge-gate', MERGED: 'merge-observer', DONE: 'complete', RECOVERING: 'recovery',
  PAUSED_CAPACITY: 'capacity-control', WAITING_HUMAN: 'human', FAILED_POLICY: 'policy',
}

export function autonomousStateForLegacyState(state: string): AutonomousState {
  return aliases[state.trim().toLocaleLowerCase('en-US')] ?? 'TRIAGE'
}

/** Explicit migration alias retained for callers upgrading legacy boards. */
export const migrateLegacyLifecycleState = autonomousStateForLegacyState

export function autonomousTaskIdentity(identifier: string, title: string): { readonly taskKey: string, readonly taskSlug: string } {
  const key = identifier.trim().toLocaleLowerCase('en-US').replaceAll(/[^a-z0-9]+/gu, '-').replaceAll(/^-+|-+$/gu, '') || 'task'
  const slug = title.trim().toLocaleLowerCase('en-US').replaceAll(/[^a-z0-9]+/gu, '-').replaceAll(/^-+|-+$/gu, '').slice(0, 80) || 'untitled-task'
  return { taskKey: key, taskSlug: slug }
}

/**
 * Project an authoritative event stream into UI data. Events are treated as
 * opaque control-plane output: malformed/incomplete streams fall back to the
 * safe legacy alias and never create a Dashboard-side transition.
 */
export function projectAutonomousLifecycle(
  identifier: string,
  title: string,
  legacyState: string,
  events?: readonly ControlPlaneTaskEvent[],
): AutonomousLifecycleView {
  const identity = autonomousTaskIdentity(identifier, title)
  const legacy = lifecycleView(identity.taskKey, identity.taskSlug, 'work', autonomousStateForLegacyState(legacyState), 'legacy-alias', emptyEvidence())
  if (events === undefined || !Array.isArray(events) || events.length === 0) return legacy
  const created = events[0]
  const taskId = `${identity.taskKey}-${identity.taskSlug}`
  if (!isControlPlaneTaskEvent(created)
    || created.type !== 'TASK_CREATED'
    || !(created.taskId === identity.taskKey || created.taskId === taskId || created.taskId.startsWith(`${identity.taskKey}-`))) return legacy
  let state: AutonomousState = 'IDEA'
  let domain: AutonomousDomain = created.domain
  let evidence = emptyEvidence()
  let recoveryAttempt = 0
  let canonicalHead: string | undefined
  const integrityWarnings: string[] = []
  let interrupt: AutonomousLifecycleView['interrupt']
  let suspendedState: AutonomousState | undefined
  for (const event of events) {
    if (!isControlPlaneTaskEvent(event) || event.taskId !== created.taskId || event.domain !== domain) return legacy
    if (event.type !== 'STATE_TRANSITIONED' || event.payload.to === undefined) continue
    const to = event.payload.to
    const nextEvidence = event.payload.evidence
    if (to === 'PR_OPEN' && nextEvidence?.headSha !== undefined) canonicalHead = nextEvidence.headSha
    if (canonicalHead !== undefined && nextEvidence?.headSha !== undefined && to !== 'PR_OPEN' && nextEvidence.headSha !== canonicalHead) {
      integrityWarnings.push(`stale evidence head ${nextEvidence.headSha} does not match PR head ${canonicalHead}`)
    }
    if (to === 'INDEPENDENT_REVIEW' && nextEvidence?.reviewerId !== undefined && nextEvidence.reviewerId === evidence.authorId) {
      integrityWarnings.push('reviewer identity matches implementation author')
    }
    if (nextEvidence !== undefined) evidence = { ...evidence, ...nextEvidence }
    if (to === 'RECOVERING') {
      recoveryAttempt += 1
      if (recoveryAttempt > 3) integrityWarnings.push('recovery attempt exceeds the control-plane limit of 3')
      suspendedState = state
      interrupt = { state: to, resumesTo: state, recoveryAttempt, ...(nextEvidence?.reason === undefined ? {} : { reason: nextEvidence.reason }), requiresHuman: false }
    } else if (to === 'PAUSED_CAPACITY' || to === 'WAITING_HUMAN' || to === 'FAILED_POLICY') {
      suspendedState = state
      interrupt = { state: to, resumesTo: state, ...(nextEvidence?.reason === undefined ? {} : { reason: nextEvidence.reason }), requiresHuman: to === 'WAITING_HUMAN' }
    } else if (suspendedState === to) {
      interrupt = undefined
      suspendedState = undefined
    }
    state = to
  }
  return lifecycleView(created.taskId, identity.taskSlug, domain, state, 'control-plane', evidence, interrupt, integrityWarnings)
}

function lifecycleView(
  taskKey: string,
  taskSlug: string,
  domain: AutonomousDomain,
  state: AutonomousState,
  source: AutonomousLifecycleView['source'],
  evidence: Required<AutonomousEvidence>,
  interrupt?: AutonomousLifecycleView['interrupt'],
  integrityWarnings: readonly string[] = [],
): AutonomousLifecycleView {
  return {
    source, taskKey, taskSlug, domain, state, currentRole: roleByState[state],
    ...(normalTransitions[state] === undefined ? {} : { nextTransition: normalTransitions[state] }),
    evidence,
    ...(interrupt === undefined ? {} : { interrupt }),
    ...(integrityWarnings.length === 0 ? {} : { integrityWarnings }),
  }
}

function emptyEvidence(): Required<AutonomousEvidence> {
  return { headSha: '', baseSha: '', pullRequestUrl: '', authorId: '', reviewerId: '', reviewId: '', testDeploymentId: '', acceptanceId: '', reason: '' }
}

/** Dashboard validation is intentionally structural only; control-plane owns semantics. */
function isControlPlaneTaskEvent(value: unknown): value is ControlPlaneTaskEvent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const event = value as Record<string, unknown>
  if (event.schemaVersion !== 'control-plane/v1'
    || (event.type !== 'TASK_CREATED' && event.type !== 'STATE_TRANSITIONED')
    || typeof event.taskId !== 'string'
    || (event.domain !== 'personal' && event.domain !== 'work')
    || event.payload === null || typeof event.payload !== 'object' || Array.isArray(event.payload)
    || event.actor === null || typeof event.actor !== 'object' || Array.isArray(event.actor)) return false
  const actor = event.actor as Record<string, unknown>
  const payload = event.payload as Record<string, unknown>
  return typeof event.eventId === 'string'
    && typeof event.occurredAt === 'string'
    && typeof actor.id === 'string'
    && actor.domain === event.domain
    && (payload.to === undefined || AUTONOMOUS_STATES.includes(payload.to as AutonomousState))
}
