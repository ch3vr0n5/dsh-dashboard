/** Strict read-side projection for the reviewed control-plane/v1 contract.
 *
 * Dashboard does not reconcile commands or authorize transitions. It verifies
 * and renders an append-only stream supplied by the external control plane.
 */

export const AUTONOMOUS_STATES = [
  'IDEA', 'TRIAGE', 'PLANNING', 'READY', 'CLAIMED', 'IMPLEMENTING',
  'LOCAL_QA', 'PR_OPEN', 'INDEPENDENT_REVIEW', 'REWORK', 'TEST_DEPLOYED',
  'ACCEPTANCE_QA', 'MERGE_READY', 'MERGED', 'DONE', 'RECOVERING',
  'PAUSED_CAPACITY', 'WAITING_HUMAN', 'FAILED_POLICY',
] as const

export type AutonomousState = (typeof AUTONOMOUS_STATES)[number]
export type AutonomousDomain = 'personal' | 'work'

export const CONTROL_PLANE_READ_TIMEOUT_MS = 2_000
export const MAX_RECOVERY_ATTEMPTS = 3

const SHA_PATTERN = /^[a-f0-9]{40}$/u
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u
const EVENT_FIELDS = ['schemaVersion', 'eventId', 'type', 'taskId', 'domain', 'actor', 'occurredAt', 'payload'] as const
const ACTOR_FIELDS = ['id', 'domain'] as const
const CREATE_FIELDS = ['title', 'initialState'] as const
const TRANSITION_FIELDS = ['to', 'evidence'] as const
const EVIDENCE_FIELDS = [
  'headSha', 'baseSha', 'pullRequestUrl', 'authorId', 'reviewerId', 'reviewId',
  'testDeploymentId', 'acceptanceId', 'reason',
] as const

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

/** Version envelope owned by the event-store adapter, not the domain event. */
export interface ControlPlaneEventRecord {
  readonly streamVersion: number
  readonly event: ControlPlaneTaskEvent
}

/** Read seam for the external append-only event store. It intentionally has no write method. */
export interface ControlPlaneReadAdapter {
  readTask(reference: ControlPlaneTaskReference, signal?: AbortSignal): Promise<ControlPlaneTaskRead | undefined>
}

export interface ControlPlaneTaskReference {
  readonly projectId: string
  readonly taskKey: string
  readonly taskSlug: string
  /** Exact event-stream id: `${taskKey}-${taskSlug}`. */
  readonly taskId: string
  readonly domain: AutonomousDomain
}

export interface ControlPlaneTaskRead {
  /** Version after applying every unique event in `events`. */
  readonly version: number
  readonly events: readonly ControlPlaneEventRecord[]
}

export type ControlPlaneReadResult =
  | { readonly status: 'ok', readonly read?: ControlPlaneTaskRead }
  | { readonly status: 'failed', readonly warning: string }

export interface AutonomousLifecycleView {
  readonly source: 'control-plane' | 'legacy-alias' | 'corrupt-stream'
  readonly taskKey: string
  readonly taskSlug: string
  readonly domain: AutonomousDomain
  readonly state: AutonomousState
  readonly currentRole: string
  readonly nextTransition?: AutonomousState
  readonly nextTransitions: readonly AutonomousState[]
  readonly evidence: Required<AutonomousEvidence>
  readonly interrupt?: {
    readonly state: Extract<AutonomousState, 'RECOVERING' | 'PAUSED_CAPACITY' | 'WAITING_HUMAN' | 'FAILED_POLICY'>
    readonly resumesTo?: AutonomousState
    readonly recoveryAttempt?: number
    readonly reason?: string
    /** A human wait is explicit only for WAITING_HUMAN, never inferred from a pause. */
    readonly requiresHuman: boolean
  }
  /** Sanitized read-model diagnostics; never used to authorize a transition. */
  readonly integrityWarnings?: readonly string[]
}

interface MutableProjection {
  state: AutonomousState
  stateActorId: string
  implementationActorId: string | undefined
  evidence: MutableEvidence
  recoveryAttempts: number
  recoverySnapshot: PreservedProjection | undefined
  suspendedSnapshot: PreservedProjection | undefined
}

type MutableEvidence = { -readonly [Field in keyof Required<AutonomousEvidence>]: Required<AutonomousEvidence>[Field] }

interface PreservedProjection {
  readonly state: AutonomousState
  readonly stateActorId: string
  readonly implementationActorId: string | undefined
  readonly evidence: Required<AutonomousEvidence>
}

const aliases: Readonly<Record<string, AutonomousState>> = {
  backlog: 'IDEA', idea: 'IDEA', todo: 'TRIAGE', triage: 'TRIAGE',
  planning: 'PLANNING', ready: 'READY', claimed: 'CLAIMED',
  working: 'IMPLEMENTING', 'in progress': 'IMPLEMENTING', implementing: 'IMPLEMENTING',
  'local qa': 'LOCAL_QA', qa: 'LOCAL_QA', 'pr open': 'PR_OPEN',
  review: 'INDEPENDENT_REVIEW', 'human review': 'INDEPENDENT_REVIEW', 'independent review': 'INDEPENDENT_REVIEW',
  rework: 'REWORK', 'test deployed': 'TEST_DEPLOYED', 'user test': 'ACCEPTANCE_QA', 'acceptance qa': 'ACCEPTANCE_QA',
  merging: 'MERGE_READY', 'merge ready': 'MERGE_READY', merged: 'MERGED', done: 'DONE',
  recovering: 'RECOVERING', 'paused capacity': 'PAUSED_CAPACITY', 'waiting human': 'WAITING_HUMAN', 'failed policy': 'FAILED_POLICY',
}

const transitions: Readonly<Record<AutonomousState, readonly AutonomousState[]>> = {
  IDEA: ['TRIAGE'], TRIAGE: ['PLANNING'], PLANNING: ['READY'], READY: ['CLAIMED'], CLAIMED: ['IMPLEMENTING'],
  IMPLEMENTING: ['LOCAL_QA'], LOCAL_QA: ['PR_OPEN'], PR_OPEN: ['INDEPENDENT_REVIEW'],
  INDEPENDENT_REVIEW: ['REWORK', 'TEST_DEPLOYED'], REWORK: ['IMPLEMENTING'], TEST_DEPLOYED: ['ACCEPTANCE_QA'],
  ACCEPTANCE_QA: ['MERGE_READY'], MERGE_READY: ['MERGED'], MERGED: ['DONE'], DONE: [],
  RECOVERING: [], PAUSED_CAPACITY: [], WAITING_HUMAN: [], FAILED_POLICY: ['TRIAGE'],
}

const roleByState: Readonly<Record<AutonomousState, string>> = {
  IDEA: 'intake', TRIAGE: 'triage', PLANNING: 'planner', READY: 'admission', CLAIMED: 'claim-owner',
  IMPLEMENTING: 'implementation', LOCAL_QA: 'local-qa', PR_OPEN: 'delivery', INDEPENDENT_REVIEW: 'independent-reviewer',
  REWORK: 'implementation', TEST_DEPLOYED: 'deployment', ACCEPTANCE_QA: 'acceptance-qa',
  MERGE_READY: 'merge-gate', MERGED: 'merge-observer', DONE: 'complete', RECOVERING: 'recovery',
  PAUSED_CAPACITY: 'capacity-control', WAITING_HUMAN: 'human', FAILED_POLICY: 'policy',
}

const suspendableStates = new Set<AutonomousState>(AUTONOMOUS_STATES.filter(state => (
  !['DONE', 'RECOVERING', 'PAUSED_CAPACITY', 'WAITING_HUMAN', 'FAILED_POLICY'].includes(state)
)))

export function autonomousStateForLegacyState(state: string): AutonomousState {
  return aliases[state.trim().toLocaleLowerCase('en-US')] ?? 'TRIAGE'
}

export const migrateLegacyLifecycleState = autonomousStateForLegacyState

export function autonomousTaskIdentity(identifier: string, title: string): { readonly taskKey: string, readonly taskSlug: string } {
  const key = identifier.trim().toLocaleLowerCase('en-US').replaceAll(/[^a-z0-9]+/gu, '-').replaceAll(/^-+|-+$/gu, '') || 'task'
  const slug = title.trim().toLocaleLowerCase('en-US').replaceAll(/[^a-z0-9]+/gu, '-').replaceAll(/^-+|-+$/gu, '').slice(0, 80) || 'untitled-task'
  return { taskKey: key, taskSlug: slug }
}

/** Bound every adapter call independently, including adapters that ignore AbortSignal. */
export async function readControlPlaneTask(
  adapter: ControlPlaneReadAdapter,
  reference: ControlPlaneTaskReference,
  timeoutMs = CONTROL_PLANE_READ_TIMEOUT_MS,
): Promise<ControlPlaneReadResult> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { status: 'failed', warning: 'control-plane read timeout is invalid' }
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error('control-plane read timed out'))
      reject(new Error(`control-plane read timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })
  try {
    const read = await Promise.race([
      Promise.resolve().then(async () => await adapter.readTask(reference, controller.signal)),
      timeout,
    ])
    return { status: 'ok', ...(read === undefined ? {} : { read }) }
  } catch (error) {
    controller.abort(error)
    return { status: 'failed', warning: sanitizeReadFailure(error) }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Missing streams use aliases; supplied invalid streams are visibly marked corrupt. */
export function projectAutonomousLifecycle(
  identifier: string,
  title: string,
  legacyState: string,
  read?: unknown,
  readFailure?: string,
): AutonomousLifecycleView {
  const identity = autonomousTaskIdentity(identifier, title)
  const expectedTaskId = `${identity.taskKey}-${identity.taskSlug}`
  const legacyStateValue = autonomousStateForLegacyState(legacyState)
  if (readFailure !== undefined) return corruptView(identity, legacyStateValue, readFailure)
  if (read === undefined) return lifecycleView(identity.taskKey, identity.taskSlug, 'work', legacyStateValue, 'legacy-alias', emptyEvidence())
  try {
    const aggregate = verifyAndProjectRead(read, expectedTaskId, 'work')
    return lifecycleView(
      expectedTaskId, identity.taskSlug, aggregate.domain, aggregate.projection.state,
      'control-plane', aggregate.projection.evidence, interruptFor(aggregate.projection),
    )
  } catch (error) {
    return corruptView(identity, legacyStateValue, integrityMessage(error))
  }
}

function verifyAndProjectRead(
  readValue: unknown,
  expectedTaskId: string,
  expectedDomain: AutonomousDomain,
): { readonly domain: AutonomousDomain, readonly projection: MutableProjection } {
  const read = plainRecord(readValue, 'read')
  exactKeys(read, ['version', 'events'], 'read')
  requiredKeys(read, ['version', 'events'], 'read')
  const version = positiveInteger(read.version, 'read.version')
  const eventValues = plainArray(read.events, 'read.events')
  if (eventValues.length === 0) throw new IntegrityError('read.events must contain TASK_CREATED')

  const seen = new Map<string, { readonly canonical: string, readonly streamVersion: number }>()
  const canonicalEvents: Array<{ readonly streamVersion: number, readonly event: ControlPlaneTaskEvent }> = []
  let previousTime = Number.NEGATIVE_INFINITY
  let previousRecordVersion = 0
  for (const [index, recordValue] of eventValues.entries()) {
    const record = plainRecord(recordValue, `read.events[${index}]`)
    exactKeys(record, ['streamVersion', 'event'], `read.events[${index}]`)
    requiredKeys(record, ['streamVersion', 'event'], `read.events[${index}]`)
    const streamVersion = positiveInteger(record.streamVersion, `read.events[${index}].streamVersion`)
    if (streamVersion < previousRecordVersion) throw new IntegrityError(`stream version ${streamVersion} is out of order after ${previousRecordVersion}`)
    previousRecordVersion = streamVersion
    const event = parseTaskEvent(record.event, `read.events[${index}].event`)
    const canonical = JSON.stringify(event)
    const duplicate = seen.get(event.eventId)
    if (duplicate !== undefined) {
      if (duplicate.canonical !== canonical) throw new IntegrityError(`eventId ${JSON.stringify(event.eventId)} conflicts with earlier event content`)
      if (duplicate.streamVersion !== streamVersion) throw new IntegrityError(`duplicate eventId ${JSON.stringify(event.eventId)} changed stream version`)
      continue
    }
    const expectedVersion = canonicalEvents.length + 1
    if (streamVersion !== expectedVersion) throw new IntegrityError(`stream version ${streamVersion} is out of order; expected ${expectedVersion}`)
    const occurredAt = Date.parse(event.occurredAt)
    if (occurredAt < previousTime) throw new IntegrityError(`event ${JSON.stringify(event.eventId)} timestamp is out of order`)
    previousTime = occurredAt
    seen.set(event.eventId, { canonical, streamVersion })
    canonicalEvents.push({ streamVersion, event })
  }
  if (version !== canonicalEvents.length) throw new IntegrityError(`read.version ${version} does not match ${canonicalEvents.length} unique events`)

  const first = canonicalEvents[0]!.event
  if (first.type !== 'TASK_CREATED') throw new IntegrityError('TASK_CREATED must be the first unique event')
  if (first.taskId !== expectedTaskId) throw new IntegrityError(`task identity does not exactly match ${JSON.stringify(expectedTaskId)}`)
  if (first.domain !== expectedDomain) throw new IntegrityError(`task domain does not exactly match ${expectedDomain}`)
  const projection: MutableProjection = {
    state: 'IDEA', stateActorId: first.actor.id, implementationActorId: undefined,
    evidence: emptyEvidence(), recoveryAttempts: 0, recoverySnapshot: undefined, suspendedSnapshot: undefined,
  }
  for (const { event } of canonicalEvents.slice(1)) {
    if (event.taskId !== expectedTaskId || event.domain !== first.domain) throw new IntegrityError('event taskId and domain must match the stream')
    if (event.type === 'TASK_CREATED') throw new IntegrityError('task stream contains more than one TASK_CREATED event')
    applyTransition(projection, event)
  }
  return { domain: first.domain, projection }
}

function applyTransition(projection: MutableProjection, event: ControlPlaneTaskEvent): void {
  const to = event.payload.to!
  const evidence = event.payload.evidence ?? {}
  const from = projection.state
  if (from === 'DONE') throw new IntegrityError('DONE tasks cannot transition')
  if (evidence.authorId !== undefined && evidence.reviewerId !== undefined && evidence.authorId === evidence.reviewerId) {
    throw new IntegrityError('same-event author and reviewer identities must differ')
  }

  const recoveryResume = from === 'RECOVERING' ? projection.recoverySnapshot : undefined
  const suspendedResume = from === 'PAUSED_CAPACITY' || from === 'WAITING_HUMAN' ? projection.suspendedSnapshot : undefined
  if (recoveryResume !== undefined || suspendedResume !== undefined) {
    const snapshot = recoveryResume ?? suspendedResume!
    if (to !== snapshot.state) throw new IntegrityError(`${from} may only resume ${snapshot.state}`)
    if (Object.keys(evidence).length !== 0) throw new IntegrityError('interrupt resume must have empty evidence')
    restoreProjection(projection, snapshot)
    if (recoveryResume !== undefined) projection.recoverySnapshot = undefined
    else projection.suspendedSnapshot = undefined
    return
  }

  const entersInterrupt = suspendableStates.has(from)
    && ['RECOVERING', 'PAUSED_CAPACITY', 'WAITING_HUMAN', 'FAILED_POLICY'].includes(to)
  if (!entersInterrupt && !transitions[from].includes(to)) throw new IntegrityError(`${from} cannot transition to ${to}`)

  if (to === 'RECOVERING') {
    if (projection.recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) throw new IntegrityError(`recovery attempts exceed ${MAX_RECOVERY_ATTEMPTS}`)
    requireString(evidence.reason, 'RECOVERING evidence.reason')
  }
  if (to === 'PR_OPEN') {
    requireSha(evidence.headSha, 'PR_OPEN evidence.headSha')
    requireSha(evidence.baseSha, 'PR_OPEN evidence.baseSha')
    requireString(evidence.pullRequestUrl, 'PR_OPEN evidence.pullRequestUrl')
    requireString(evidence.authorId, 'PR_OPEN evidence.authorId')
    if (projection.implementationActorId === undefined
      || evidence.authorId !== projection.implementationActorId
      || event.actor.id !== projection.implementationActorId) throw new IntegrityError('PR author and actor must match the implementation actor')
  }
  if (['INDEPENDENT_REVIEW', 'REWORK', 'TEST_DEPLOYED', 'ACCEPTANCE_QA', 'MERGE_READY', 'MERGED'].includes(to)) {
    requireSha(evidence.headSha, `${to} evidence.headSha`)
    if (projection.evidence.headSha === '' || evidence.headSha !== projection.evidence.headSha) throw new IntegrityError(`${to} evidence is stale for the current exact head`)
  }
  if (to === 'INDEPENDENT_REVIEW') {
    requireString(evidence.reviewerId, 'INDEPENDENT_REVIEW evidence.reviewerId')
    requireString(evidence.reviewId, 'INDEPENDENT_REVIEW evidence.reviewId')
    if (evidence.reviewerId !== event.actor.id || event.actor.id === projection.implementationActorId) {
      throw new IntegrityError('reviewer must be the acting identity and differ from the implementation actor')
    }
  }
  if (to === 'REWORK' || to === 'TEST_DEPLOYED') {
    requireString(evidence.reviewerId, `${to} evidence.reviewerId`)
    requireString(evidence.reviewId, `${to} evidence.reviewId`)
    if (event.actor.id !== projection.evidence.reviewerId
      || evidence.reviewerId !== projection.evidence.reviewerId
      || evidence.reviewId !== projection.evidence.reviewId) throw new IntegrityError(`${to} must be authorized by the recorded reviewer and review`)
    if (to === 'TEST_DEPLOYED') requireString(evidence.testDeploymentId, 'TEST_DEPLOYED evidence.testDeploymentId')
  }
  if (to === 'ACCEPTANCE_QA') requireString(evidence.acceptanceId, 'ACCEPTANCE_QA evidence.acceptanceId')

  if (to === 'RECOVERING') {
    projection.recoveryAttempts += 1
    projection.recoverySnapshot = captureProjection(projection)
  }
  if (to === 'PAUSED_CAPACITY' || to === 'WAITING_HUMAN') projection.suspendedSnapshot = captureProjection(projection)
  if (to === 'IMPLEMENTING') {
    projection.implementationActorId = event.actor.id
    projection.evidence.authorId = event.actor.id
  }
  if (to === 'PR_OPEN') {
    projection.evidence = {
      ...emptyEvidence(), headSha: evidence.headSha!, baseSha: evidence.baseSha!,
      pullRequestUrl: evidence.pullRequestUrl!, authorId: evidence.authorId!,
    }
  }
  if (to === 'INDEPENDENT_REVIEW') {
    projection.evidence.reviewerId = event.actor.id
    projection.evidence.reviewId = evidence.reviewId!
  }
  if (to === 'TEST_DEPLOYED') projection.evidence.testDeploymentId = evidence.testDeploymentId!
  if (to === 'ACCEPTANCE_QA') projection.evidence.acceptanceId = evidence.acceptanceId!
  projection.evidence.reason = ['RECOVERING', 'PAUSED_CAPACITY', 'WAITING_HUMAN', 'FAILED_POLICY'].includes(to) ? evidence.reason ?? '' : ''
  projection.state = to
  projection.stateActorId = event.actor.id
}

function captureProjection(projection: MutableProjection): PreservedProjection {
  return {
    state: projection.state, stateActorId: projection.stateActorId,
    implementationActorId: projection.implementationActorId, evidence: { ...projection.evidence },
  }
}

function restoreProjection(projection: MutableProjection, snapshot: PreservedProjection): void {
  projection.state = snapshot.state
  projection.stateActorId = snapshot.stateActorId
  projection.implementationActorId = snapshot.implementationActorId
  projection.evidence = { ...snapshot.evidence }
}

function interruptFor(projection: MutableProjection): AutonomousLifecycleView['interrupt'] {
  if (projection.state === 'RECOVERING' && projection.recoverySnapshot !== undefined) {
    return {
      state: 'RECOVERING', resumesTo: projection.recoverySnapshot.state, recoveryAttempt: projection.recoveryAttempts,
      ...(projection.evidence.reason === '' ? {} : { reason: projection.evidence.reason }), requiresHuman: false,
    }
  }
  if ((projection.state === 'PAUSED_CAPACITY' || projection.state === 'WAITING_HUMAN') && projection.suspendedSnapshot !== undefined) {
    return {
      state: projection.state, resumesTo: projection.suspendedSnapshot.state,
      ...(projection.evidence.reason === '' ? {} : { reason: projection.evidence.reason }),
      requiresHuman: projection.state === 'WAITING_HUMAN',
    }
  }
  if (projection.state === 'FAILED_POLICY') {
    return { state: 'FAILED_POLICY', ...(projection.evidence.reason === '' ? {} : { reason: projection.evidence.reason }), requiresHuman: false }
  }
  return undefined
}

function parseTaskEvent(value: unknown, name: string): ControlPlaneTaskEvent {
  const event = plainRecord(value, name)
  exactKeys(event, EVENT_FIELDS, name)
  requiredKeys(event, EVENT_FIELDS, name)
  if (event.schemaVersion !== 'control-plane/v1') throw new IntegrityError(`${name}.schemaVersion is unsupported`)
  const eventId = nonBlankString(event.eventId, `${name}.eventId`)
  const taskId = nonBlankString(event.taskId, `${name}.taskId`)
  if (event.domain !== 'personal' && event.domain !== 'work') throw new IntegrityError(`${name}.domain is invalid`)
  const domain = event.domain
  const actorValue = plainRecord(event.actor, `${name}.actor`)
  exactKeys(actorValue, ACTOR_FIELDS, `${name}.actor`)
  requiredKeys(actorValue, ACTOR_FIELDS, `${name}.actor`)
  const actorId = nonBlankString(actorValue.id, `${name}.actor.id`)
  if (actorValue.domain !== domain) throw new IntegrityError(`${name}.actor.domain must match the task domain`)
  const occurredAt = timestamp(event.occurredAt, `${name}.occurredAt`)
  const payloadValue = plainRecord(event.payload, `${name}.payload`)

  if (event.type === 'TASK_CREATED') {
    exactKeys(payloadValue, CREATE_FIELDS, `${name}.payload`)
    requiredKeys(payloadValue, ['title'], `${name}.payload`)
    const title = nonBlankString(payloadValue.title, `${name}.payload.title`)
    if (payloadValue.initialState !== undefined && payloadValue.initialState !== 'IDEA') throw new IntegrityError(`${name}.payload.initialState must be IDEA`)
    return {
      schemaVersion: 'control-plane/v1', eventId, type: 'TASK_CREATED', taskId, domain,
      actor: { id: actorId, domain }, occurredAt,
      payload: { title, ...(payloadValue.initialState === undefined ? {} : { initialState: 'IDEA' }) },
    }
  }
  if (event.type !== 'STATE_TRANSITIONED') throw new IntegrityError(`${name}.type is invalid`)
  exactKeys(payloadValue, TRANSITION_FIELDS, `${name}.payload`)
  requiredKeys(payloadValue, ['to'], `${name}.payload`)
  if (!AUTONOMOUS_STATES.includes(payloadValue.to as AutonomousState)) throw new IntegrityError(`${name}.payload.to is invalid`)
  const evidence = payloadValue.evidence === undefined ? undefined : parseEvidence(payloadValue.evidence, `${name}.payload.evidence`)
  return {
    schemaVersion: 'control-plane/v1', eventId, type: 'STATE_TRANSITIONED', taskId, domain,
    actor: { id: actorId, domain }, occurredAt,
    payload: { to: payloadValue.to as AutonomousState, ...(evidence === undefined ? {} : { evidence }) },
  }
}

function parseEvidence(value: unknown, name: string): AutonomousEvidence {
  const evidence = plainRecord(value, name)
  exactKeys(evidence, EVIDENCE_FIELDS, name)
  const parsed: Record<string, string> = {}
  for (const field of EVIDENCE_FIELDS) {
    const fieldValue = evidence[field]
    if (fieldValue === undefined) continue
    if (field === 'headSha' || field === 'baseSha') requireSha(fieldValue, `${name}.${field}`)
    else requireString(fieldValue, `${name}.${field}`)
    parsed[field] = fieldValue as string
  }
  return parsed
}

function plainRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new IntegrityError(`${name} must be a plain object`)
  let prototype: object | null
  let descriptors: PropertyDescriptorMap
  try {
    prototype = Object.getPrototypeOf(value) as object | null
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch {
    throw new IntegrityError(`${name} cannot be safely inspected`)
  }
  if (prototype !== Object.prototype && prototype !== null) throw new IntegrityError(`${name} must be a plain object`)
  const safe: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key]!
    if (typeof key === 'symbol' || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new IntegrityError(`${name} contains an unsafe property`)
    }
    safe[key] = descriptor.value
  }
  return safe
}

function plainArray(value: unknown, name: string): readonly unknown[] {
  let array: unknown[]
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new IntegrityError(`${name} must be an array`)
    array = value
  } catch (error) {
    if (error instanceof IntegrityError) throw error
    throw new IntegrityError(`${name} cannot be safely inspected`)
  }
  let descriptors: PropertyDescriptorMap
  try {
    descriptors = Object.getOwnPropertyDescriptors(array) as unknown as PropertyDescriptorMap
  } catch {
    throw new IntegrityError(`${name} cannot be safely inspected`)
  }
  const lengthDescriptor = descriptors.length
  if (lengthDescriptor === undefined || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value') || !Number.isSafeInteger(lengthDescriptor.value)) {
    throw new IntegrityError(`${name} has an unsafe length`)
  }
  const safe: unknown[] = []
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = descriptors[String(index)]
    if (descriptor === undefined || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new IntegrityError(`${name} must be dense data properties`)
    }
    safe.push(descriptor.value)
  }
  const extra = Reflect.ownKeys(descriptors).find(key => key !== 'length' && (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(key)))
  if (extra !== undefined) throw new IntegrityError(`${name} contains an unsafe property`)
  return safe
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const keys = Object.keys(record)
  const extra = keys.find(key => !allowed.includes(key))
  if (extra !== undefined) throw new IntegrityError(`${name} contains unsupported field ${JSON.stringify(extra)}`)
}

function requiredKeys(record: Record<string, unknown>, required: readonly string[], name: string): void {
  const missing = required.find(key => !Object.prototype.hasOwnProperty.call(record, key))
  if (missing !== undefined) throw new IntegrityError(`${name} is missing field ${JSON.stringify(missing)}`)
}

function nonBlankString(value: unknown, name: string): string {
  requireString(value, name)
  return value
}

function requireString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') throw new IntegrityError(`${name} must be a non-empty string`)
}

function requireSha(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !SHA_PATTERN.test(value)) throw new IntegrityError(`${name} must be a lowercase full 40-character Git SHA`)
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) throw new IntegrityError(`${name} must be a positive integer`)
  return value as number
}

function timestamp(value: unknown, name: string): string {
  if (typeof value !== 'string' || !RFC3339_PATTERN.test(value)) throw new IntegrityError(`${name} must use the uppercase-T/Z RFC3339 profile`)
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/u.exec(value)!
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3])
  const hour = Number(match[4]); const minute = Number(match[5]); const second = Number(match[6])
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  const offset = /([+-])(\d{2}):(\d{2})$/u.exec(value)
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]!
    || hour > 23 || minute > 59 || second > 59
    || (offset !== null && (Number(offset[2]) > 23 || Number(offset[3]) > 59))
    || !Number.isFinite(Date.parse(value))) throw new IntegrityError(`${name} must be a valid RFC3339 timestamp`)
  return value
}

function emptyEvidence(): Required<AutonomousEvidence> {
  return { headSha: '', baseSha: '', pullRequestUrl: '', authorId: '', reviewerId: '', reviewId: '', testDeploymentId: '', acceptanceId: '', reason: '' }
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
  const nextTransitions = transitions[state]
  return {
    source, taskKey, taskSlug, domain, state, currentRole: roleByState[state], nextTransitions,
    ...(nextTransitions[0] === undefined ? {} : { nextTransition: nextTransitions[0] }),
    evidence: { ...evidence },
    ...(interrupt === undefined ? {} : { interrupt }),
    ...(integrityWarnings.length === 0 ? {} : { integrityWarnings: [...integrityWarnings] }),
  }
}

function corruptView(
  identity: { readonly taskKey: string, readonly taskSlug: string },
  state: AutonomousState,
  warning: string,
): AutonomousLifecycleView {
  return lifecycleView(identity.taskKey, identity.taskSlug, 'work', state, 'corrupt-stream', emptyEvidence(), undefined, [warning])
}

function sanitizeReadFailure(error: unknown): string {
  if (error instanceof Error && error.message.includes('timed out')) return error.message
  return 'control-plane read failed; stream was not projected'
}

function integrityMessage(error: unknown): string {
  return error instanceof IntegrityError ? error.message : 'control-plane stream is corrupt'
}

class IntegrityError extends Error {}
