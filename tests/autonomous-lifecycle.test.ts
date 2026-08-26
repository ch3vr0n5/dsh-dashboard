import { describe, expect, it, vi } from 'vitest'
import {
  AUTONOMOUS_EVIDENCE_FIELDS_BY_STATE,
  AUTONOMOUS_STATES,
  migrateLegacyLifecycleState,
  projectAutonomousLifecycle,
  readControlPlaneTask,
  type AutonomousEvidence,
  type AutonomousEvidenceField,
  type AutonomousState,
  type ControlPlaneEventRecord,
  type ControlPlaneReadAdapter,
  type ControlPlaneTaskEvent,
  type ControlPlaneTaskRead,
  type ControlPlaneTaskReference,
} from '../src/lifecycle/autonomous.ts'

const shaA = 'a'.repeat(40)
const shaB = 'b'.repeat(40)
const title = 'Ship autonomous lifecycle'
const taskId = 'local-42-ship-autonomous-lifecycle'
const reference: ControlPlaneTaskReference = {
  projectId: 'project', taskKey: 'local-42', taskSlug: 'ship-autonomous-lifecycle', taskId, domain: 'work',
}

function time(version: number): string {
  return `2026-08-26T10:${String(version).padStart(2, '0')}:00.000Z`
}

function created(overrides: Partial<ControlPlaneTaskEvent> = {}): ControlPlaneTaskEvent {
  return {
    schemaVersion: 'control-plane/v1', eventId: 'created', type: 'TASK_CREATED', taskId, domain: 'work',
    actor: { id: 'intake', domain: 'work' }, occurredAt: time(1), payload: { title, initialState: 'IDEA' },
    ...overrides,
  }
}

function transitioned(
  version: number,
  to: AutonomousState,
  actorId: string,
  evidence: AutonomousEvidence = {},
  eventId = `event-${version}`,
): ControlPlaneTaskEvent {
  return {
    schemaVersion: 'control-plane/v1', eventId, type: 'STATE_TRANSITIONED', taskId, domain: 'work',
    actor: { id: actorId, domain: 'work' }, occurredAt: time(version), payload: { to, evidence },
  }
}

function record(streamVersion: number, event: ControlPlaneTaskEvent): ControlPlaneEventRecord {
  return { streamVersion, event }
}

function read(events: readonly ControlPlaneEventRecord[], version = new Set(events.map(item => item.event.eventId)).size): ControlPlaneTaskRead {
  return { version, events }
}

function implementationPrefix(): ControlPlaneEventRecord[] {
  return [
    record(1, created()),
    record(2, transitioned(2, 'TRIAGE', 'triage')),
    record(3, transitioned(3, 'PLANNING', 'planner')),
    record(4, transitioned(4, 'READY', 'planner')),
    record(5, transitioned(5, 'CLAIMED', 'claimer')),
    record(6, transitioned(6, 'IMPLEMENTING', 'author')),
  ]
}

function prPrefix(): ControlPlaneEventRecord[] {
  return [
    ...implementationPrefix(),
    record(7, transitioned(7, 'LOCAL_QA', 'qa')),
    record(8, transitioned(8, 'PR_OPEN', 'author', {
      headSha: shaA, baseSha: shaB, pullRequestUrl: 'https://example.test/pr/42', authorId: 'author',
    })),
  ]
}

function reviewPrefix(): ControlPlaneEventRecord[] {
  return [
    ...prPrefix(),
    record(9, transitioned(9, 'INDEPENDENT_REVIEW', 'reviewer', {
      headSha: shaA, reviewerId: 'reviewer', reviewId: 'review-42',
    })),
  ]
}

function validStreamForState(state: AutonomousState): ControlPlaneEventRecord[] {
  const normalFlow: ControlPlaneEventRecord[] = [
    record(1, created()),
    record(2, transitioned(2, 'TRIAGE', 'triage')),
    record(3, transitioned(3, 'PLANNING', 'planner')),
    record(4, transitioned(4, 'READY', 'planner')),
    record(5, transitioned(5, 'CLAIMED', 'claimer')),
    record(6, transitioned(6, 'IMPLEMENTING', 'author')),
    record(7, transitioned(7, 'LOCAL_QA', 'qa')),
    record(8, transitioned(8, 'PR_OPEN', 'author', {
      headSha: shaA, baseSha: shaB, pullRequestUrl: 'https://example.test/pr/42', authorId: 'author',
    })),
    record(9, transitioned(9, 'INDEPENDENT_REVIEW', 'reviewer', {
      headSha: shaA, reviewerId: 'reviewer', reviewId: 'review-42',
    })),
    record(10, transitioned(10, 'TEST_DEPLOYED', 'reviewer', {
      headSha: shaA, reviewerId: 'reviewer', reviewId: 'review-42', testDeploymentId: 'deploy-42',
    })),
    record(11, transitioned(11, 'ACCEPTANCE_QA', 'acceptance', { headSha: shaA, acceptanceId: 'acceptance-42' })),
    record(12, transitioned(12, 'MERGE_READY', 'merge-gate', { headSha: shaA })),
    record(13, transitioned(13, 'MERGED', 'merge-observer', { headSha: shaA })),
    record(14, transitioned(14, 'DONE', 'completion')),
  ]
  const normalIndex = [
    'IDEA', 'TRIAGE', 'PLANNING', 'READY', 'CLAIMED', 'IMPLEMENTING', 'LOCAL_QA', 'PR_OPEN',
    'INDEPENDENT_REVIEW', 'TEST_DEPLOYED', 'ACCEPTANCE_QA', 'MERGE_READY', 'MERGED', 'DONE',
  ].indexOf(state)
  if (normalIndex >= 0) return normalFlow.slice(0, normalIndex + 1)
  if (state === 'REWORK') {
    return [...reviewPrefix(), record(10, transitioned(10, 'REWORK', 'reviewer', {
      headSha: shaA, reviewerId: 'reviewer', reviewId: 'review-42',
    }))]
  }
  if (state === 'RECOVERING' || state === 'PAUSED_CAPACITY' || state === 'WAITING_HUMAN' || state === 'FAILED_POLICY') {
    return [...implementationPrefix(), record(7, transitioned(7, state, 'operator', { reason: `${state} reason` }))]
  }
  throw new Error(`missing test stream for ${state}`)
}

function project(stream: unknown) {
  return projectAutonomousLifecycle('LOCAL-42', title, 'Working', stream)
}

describe('autonomous lifecycle strict read projection', () => {
  it('migrates the old board pipeline through stable target-state aliases', () => {
    expect(migrateLegacyLifecycleState('Backlog')).toBe('IDEA')
    expect(migrateLegacyLifecycleState('Ready')).toBe('READY')
    expect(migrateLegacyLifecycleState('Working')).toBe('IMPLEMENTING')
    expect(migrateLegacyLifecycleState('User Test')).toBe('ACCEPTANCE_QA')
    expect(migrateLegacyLifecycleState('Provider Custom State')).toBeUndefined()
    expect(projectAutonomousLifecycle('LOCAL-42', title, 'Provider Custom State')).toMatchObject({
      source: 'legacy-unmapped', state: 'UNMAPPED', providerState: 'Provider Custom State', currentRole: 'unmapped', nextTransitions: [],
    })
  })

  it('defines and accepts the exact canonical evidence fields for every state', () => {
    expect(AUTONOMOUS_EVIDENCE_FIELDS_BY_STATE).toEqual({
      IDEA: [], TRIAGE: [], PLANNING: [], READY: [], CLAIMED: [], IMPLEMENTING: [], LOCAL_QA: [],
      PR_OPEN: ['headSha', 'baseSha', 'pullRequestUrl', 'authorId'],
      INDEPENDENT_REVIEW: ['headSha', 'reviewerId', 'reviewId'],
      REWORK: ['headSha', 'reviewerId', 'reviewId'],
      TEST_DEPLOYED: ['headSha', 'reviewerId', 'reviewId', 'testDeploymentId'],
      ACCEPTANCE_QA: ['headSha', 'acceptanceId'], MERGE_READY: ['headSha'], MERGED: ['headSha'], DONE: [],
      RECOVERING: ['reason'], PAUSED_CAPACITY: ['reason'], WAITING_HUMAN: ['reason'], FAILED_POLICY: ['reason'],
    })
    expect(Object.keys(AUTONOMOUS_EVIDENCE_FIELDS_BY_STATE)).toEqual(AUTONOMOUS_STATES)
    for (const state of AUTONOMOUS_STATES) {
      expect(project(read(validStreamForState(state))), state).toMatchObject({ source: 'control-plane', state })
    }
  })

  it('rejects recognized evidence fields outside their target state instead of discarding them', () => {
    const fieldValues: Readonly<Record<AutonomousEvidenceField, string>> = {
      headSha: shaA, baseSha: shaB, pullRequestUrl: 'https://example.test/pr/42', authorId: 'author',
      reviewerId: 'reviewer', reviewId: 'review-42', testDeploymentId: 'deploy-42',
      acceptanceId: 'acceptance-42', reason: 'reason',
    }
    const fields = Object.keys(fieldValues) as AutonomousEvidenceField[]

    const ideaWithEvidence = created() as unknown as { payload: Record<string, unknown> }
    ideaWithEvidence.payload = { ...ideaWithEvidence.payload, evidence: { headSha: shaA } }
    expect(project(read([record(1, ideaWithEvidence as unknown as ControlPlaneTaskEvent)]))).toMatchObject({ source: 'corrupt-stream' })

    for (const state of AUTONOMOUS_STATES.filter(state => state !== 'IDEA')) {
      const events = validStreamForState(state)
      const last = events.at(-1)!
      const extraneousFields = fields.filter(field => !AUTONOMOUS_EVIDENCE_FIELDS_BY_STATE[state].includes(field))
      for (const extraneous of extraneousFields) {
        const badEvent: ControlPlaneTaskEvent = {
          ...last.event,
          payload: { ...last.event.payload, evidence: { ...last.event.payload.evidence, [extraneous]: fieldValues[extraneous] } },
        }
        const bad = project(read([...events.slice(0, -1), record(last.streamVersion, badEvent)]))
        expect(bad.source, `${state} accepted extraneous ${extraneous}`).toBe('corrupt-stream')
        expect(bad.integrityWarnings?.[0]).toContain(`${state} evidence field \"${extraneous}\" is extraneous`)
      }
    }

    const triageWithHead = project(read([
      record(1, created()), record(2, transitioned(2, 'TRIAGE', 'triage', { headSha: shaA })),
    ]))
    expect(triageWithHead.integrityWarnings?.[0]).toContain('TRIAGE evidence field \"headSha\" is extraneous')
    const waitingWithStaleHead = project(read([
      ...implementationPrefix(),
      record(7, transitioned(7, 'WAITING_HUMAN', 'operator', { reason: 'decision', headSha: shaB })),
    ]))
    expect(waitingWithStaleHead.integrityWarnings?.[0]).toContain('WAITING_HUMAN evidence field \"headSha\" is extraneous')
  })

  it('enforces the canonical order and projects exact-head evidence with separate role identities', () => {
    const events = [
      ...prPrefix(),
      record(9, transitioned(9, 'INDEPENDENT_REVIEW', 'reviewer', { headSha: shaA, reviewerId: 'reviewer', reviewId: 'review-42' })),
      record(10, transitioned(10, 'TEST_DEPLOYED', 'reviewer', {
        headSha: shaA, reviewerId: 'reviewer', reviewId: 'review-42', testDeploymentId: 'deploy-42',
      })),
    ]
    const view = project(read(events))

    expect(view).toMatchObject({
      source: 'control-plane', taskKey: taskId, state: 'TEST_DEPLOYED', currentRole: 'deployment',
      nextTransitions: ['ACCEPTANCE_QA'],
      evidence: { headSha: shaA, authorId: 'author', reviewerId: 'reviewer', reviewId: 'review-42', testDeploymentId: 'deploy-42' },
    })
    expect(view.integrityWarnings).toBeUndefined()
  })

  it('marks illegal transitions and non-exact task identities corrupt instead of silently using a legacy source', () => {
    const illegal = project(read([record(1, created()), record(2, transitioned(2, 'IMPLEMENTING', 'author'))]))
    expect(illegal).toMatchObject({ source: 'corrupt-stream', state: 'IMPLEMENTING', evidence: { headSha: '' } })
    expect(illegal.integrityWarnings?.[0]).toContain('IDEA cannot transition to IMPLEMENTING')

    const prefixed = created({ taskId: `${taskId}-extra` })
    const wrongIdentity = project(read([record(1, prefixed)]))
    expect(wrongIdentity.source).toBe('corrupt-stream')
    expect(wrongIdentity.integrityWarnings?.[0]).toContain('does not exactly match')

    const wrongDomain = created({ domain: 'personal', actor: { id: 'intake', domain: 'personal' } })
    expect(project(read([record(1, wrongDomain)])).integrityWarnings?.[0]).toContain('domain does not exactly match')
  })

  it('rejects malformed IDs, timestamps, evidence, extra fields, and unsafe objects without rendering their values', () => {
    const blankId = project(read([record(1, created({ eventId: ' ' }))]))
    expect(blankId.source).toBe('corrupt-stream')

    const badTimestamp = project(read([record(1, created({ occurredAt: '2026-08-26t10:00:00z' }))]))
    expect(badTimestamp.integrityWarnings?.[0]).toContain('RFC3339')

    const unknownEvidence = read([
      ...implementationPrefix(),
      record(7, transitioned(7, 'LOCAL_QA', 'qa', { unknown: 'DO-NOT-RENDER' } as AutonomousEvidence)),
    ])
    const unknown = project(unknownEvidence)
    expect(unknown.source).toBe('corrupt-stream')
    expect(JSON.stringify(unknown)).not.toContain('DO-NOT-RENDER')

    const nullEvidenceEvent = transitioned(7, 'LOCAL_QA', 'qa') as unknown as { payload: { evidence: null } }
    nullEvidenceEvent.payload.evidence = null
    expect(project(read([...implementationPrefix(), record(7, nullEvidenceEvent as unknown as ControlPlaneTaskEvent)]))).toMatchObject({ source: 'corrupt-stream' })

    const unsafe = Object.create({ inherited: true }) as Record<string, unknown>
    Object.assign(unsafe, read([record(1, created())]))
    expect(project(unsafe)).toMatchObject({ source: 'corrupt-stream' })
  })

  it('enforces exact-head, implementation actor, independent reviewer, and same-event identity constraints', () => {
    const stale = project(read([
      ...prPrefix(),
      record(9, transitioned(9, 'INDEPENDENT_REVIEW', 'reviewer', { headSha: shaB, reviewerId: 'reviewer', reviewId: 'review-42' })),
    ]))
    expect(stale.integrityWarnings?.[0]).toContain('stale')

    const wrongPrActor = project(read([
      ...implementationPrefix(),
      record(7, transitioned(7, 'LOCAL_QA', 'qa')),
      record(8, transitioned(8, 'PR_OPEN', 'delivery', { headSha: shaA, baseSha: shaB, pullRequestUrl: 'https://example.test/pr/42', authorId: 'author' })),
    ]))
    expect(wrongPrActor.integrityWarnings?.[0]).toContain('implementation actor')

    const authorReviews = project(read([
      ...prPrefix(),
      record(9, transitioned(9, 'INDEPENDENT_REVIEW', 'author', { headSha: shaA, reviewerId: 'author', reviewId: 'review-42' })),
    ]))
    expect(authorReviews.integrityWarnings?.[0]).toContain('differ from the implementation actor')

    const sameEventCollision = project(read([
      ...prPrefix(),
      record(9, transitioned(9, 'INDEPENDENT_REVIEW', 'reviewer', {
        headSha: shaA, authorId: 'reviewer', reviewerId: 'reviewer', reviewId: 'review-42',
      })),
    ]))
    expect(sameEventCollision.integrityWarnings?.[0]).toContain('evidence field \"authorId\" is extraneous')
  })

  it('deduplicates identical IDs and rejects conflicts, version gaps, version drift, and timestamp disorder', () => {
    const triage = record(2, transitioned(2, 'TRIAGE', 'triage', {}, 'triage'))
    const deduped = project(read([record(1, created()), triage, structuredClone(triage)]))
    expect(deduped).toMatchObject({ source: 'control-plane', state: 'TRIAGE' })

    const conflict = record(2, transitioned(2, 'PLANNING', 'triage', {}, 'triage'))
    expect(project(read([record(1, created()), triage, conflict])).integrityWarnings?.[0]).toContain('conflicts')

    expect(project(read([record(1, created()), record(3, transitioned(2, 'TRIAGE', 'triage'))])).integrityWarnings?.[0]).toContain('out of order')
    expect(project(read([record(1, created()), triage, record(1, created())])).integrityWarnings?.[0]).toContain('out of order')
    expect(project(read([record(1, created())], 2)).integrityWarnings?.[0]).toContain('does not match')

    const backwards = { ...transitioned(2, 'TRIAGE', 'triage'), occurredAt: time(0) }
    expect(project(read([record(1, created()), record(2, backwards)])).integrityWarnings?.[0]).toContain('timestamp is out of order')
  })

  it('bounds, deduplicates, and orders recovery while requiring exact empty-payload resume', () => {
    const prefix = implementationPrefix()
    const recover1 = record(7, transitioned(7, 'RECOVERING', 'recovery', { reason: 'one' }, 'recover-1'))
    const events = [
      ...prefix,
      recover1,
      structuredClone(recover1),
      record(8, transitioned(8, 'IMPLEMENTING', 'author', {}, 'resume-1')),
      record(9, transitioned(9, 'RECOVERING', 'recovery', { reason: 'two' }, 'recover-2')),
      record(10, transitioned(10, 'IMPLEMENTING', 'author', {}, 'resume-2')),
      record(11, transitioned(11, 'RECOVERING', 'recovery', { reason: 'three' }, 'recover-3')),
      record(12, transitioned(12, 'IMPLEMENTING', 'author', {}, 'resume-3')),
    ]
    expect(project(read(events))).toMatchObject({ source: 'control-plane', state: 'IMPLEMENTING' })

    const fourth = project(read([...events, record(13, transitioned(13, 'RECOVERING', 'recovery', { reason: 'four' }, 'recover-4'))]))
    expect(fourth.integrityWarnings?.[0]).toContain('exceed 3')

    const resumeEvidence = project(read([
      ...prefix, recover1,
      record(8, transitioned(8, 'IMPLEMENTING', 'author', { reason: 'must be empty' }, 'resume-bad')),
    ]))
    expect(resumeEvidence.integrityWarnings?.[0]).toContain('IMPLEMENTING evidence field \"reason\" is extraneous')
  })

  it('distinguishes a true human wait and restores its exact preserved projection on resume', () => {
    const waitingEvents = [
      ...implementationPrefix(),
      record(7, transitioned(7, 'WAITING_HUMAN', 'operator', { reason: 'acceptance decision required' })),
    ]
    const waiting = project(read(waitingEvents))
    expect(waiting.interrupt).toMatchObject({ state: 'WAITING_HUMAN', resumesTo: 'IMPLEMENTING', requiresHuman: true })

    const resumed = project(read([
      ...waitingEvents,
      record(8, transitioned(8, 'IMPLEMENTING', 'author')),
    ]))
    expect(resumed).toMatchObject({ source: 'control-plane', state: 'IMPLEMENTING', evidence: { authorId: 'author' } })
    expect(resumed.interrupt).toBeUndefined()
  })

  it('passes AbortSignal and contains each rejected or hung adapter read behind a hard timeout', async () => {
    let hungSignal: AbortSignal | undefined
    const hung: ControlPlaneReadAdapter = {
      readTask: vi.fn(async (_reference, signal) => {
        hungSignal = signal
        return await new Promise<ControlPlaneTaskRead>(() => {})
      }),
    }
    const fast: ControlPlaneReadAdapter = { readTask: vi.fn(async () => undefined) }
    const started = Date.now()
    const [hungResult, fastResult] = await Promise.all([
      readControlPlaneTask(hung, reference, 10),
      readControlPlaneTask(fast, reference, 10),
    ])
    expect(Date.now() - started).toBeLessThan(500)
    expect(hungResult).toMatchObject({ status: 'failed', warning: expect.stringContaining('timed out') })
    expect(hungSignal?.aborted).toBe(true)
    expect(fastResult).toEqual({ status: 'ok' })

    const rejected = await readControlPlaneTask({ readTask: vi.fn(async () => { throw { secret: 'DO-NOT-RENDER' } }) }, reference, 10)
    expect(rejected).toEqual({ status: 'failed', warning: 'control-plane read failed; stream was not projected' })
    expect(projectAutonomousLifecycle('LOCAL-42', title, 'Working', undefined, rejected.status === 'failed' ? rejected.warning : undefined)).toMatchObject({
      source: 'corrupt-stream', integrityWarnings: ['control-plane read failed; stream was not projected'],
    })
  })
})
