import { describe, expect, it, vi } from 'vitest'
import {
  migrateLegacyLifecycleState,
  projectAutonomousLifecycle,
  readControlPlaneTask,
  type AutonomousEvidence,
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

function project(stream: unknown) {
  return projectAutonomousLifecycle('LOCAL-42', title, 'Working', stream)
}

describe('autonomous lifecycle strict read projection', () => {
  it('migrates the old board pipeline through stable target-state aliases', () => {
    expect(migrateLegacyLifecycleState('Backlog')).toBe('IDEA')
    expect(migrateLegacyLifecycleState('Ready')).toBe('READY')
    expect(migrateLegacyLifecycleState('Working')).toBe('IMPLEMENTING')
    expect(migrateLegacyLifecycleState('User Test')).toBe('ACCEPTANCE_QA')
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
    expect(sameEventCollision.integrityWarnings?.[0]).toContain('same-event author and reviewer')
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
    expect(resumeEvidence.integrityWarnings?.[0]).toContain('empty evidence')
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
