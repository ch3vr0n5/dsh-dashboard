import { describe, expect, it } from 'vitest'
import {
  migrateLegacyLifecycleState,
  projectAutonomousLifecycle,
  type AutonomousEvidence,
  type AutonomousState,
  type ControlPlaneTaskEvent,
} from '../src/lifecycle/autonomous.ts'

const shaA = 'a'.repeat(40)
const shaB = 'b'.repeat(40)
const title = 'Ship autonomous lifecycle'
const taskId = 'local-42-ship-autonomous-lifecycle'

function created(): ControlPlaneTaskEvent {
  return {
    schemaVersion: 'control-plane/v1', eventId: 'created', type: 'TASK_CREATED', taskId, domain: 'work',
    actor: { id: 'intake', domain: 'work' }, occurredAt: '2026-08-26T10:00:00.000Z',
    payload: { title, initialState: 'IDEA' },
  }
}

function transitioned(eventId: string, to: AutonomousState, actorId: string, evidence: AutonomousEvidence = {}): ControlPlaneTaskEvent {
  return {
    schemaVersion: 'control-plane/v1', eventId, type: 'STATE_TRANSITIONED', taskId, domain: 'work',
    actor: { id: actorId, domain: 'work' }, occurredAt: `2026-08-26T10:0${eventId.length}:00.000Z`,
    payload: { to, evidence },
  }
}

describe('autonomous lifecycle read projection', () => {
  it('migrates the old board pipeline through stable target-state aliases', () => {
    expect(migrateLegacyLifecycleState('Backlog')).toBe('IDEA')
    expect(migrateLegacyLifecycleState('Ready')).toBe('READY')
    expect(migrateLegacyLifecycleState('Working')).toBe('IMPLEMENTING')
    expect(migrateLegacyLifecycleState('User Test')).toBe('ACCEPTANCE_QA')
  })

  it('projects exact-head evidence and keeps author and reviewer identities separate', () => {
    const view = projectAutonomousLifecycle('LOCAL-42', title, 'Working', [
      created(),
      transitioned('implementing', 'IMPLEMENTING', 'author'),
      transitioned('pr', 'PR_OPEN', 'author', { headSha: shaA, baseSha: shaB, pullRequestUrl: 'https://example.test/pr/42', authorId: 'author' }),
      transitioned('review', 'INDEPENDENT_REVIEW', 'reviewer', { headSha: shaA, reviewerId: 'reviewer', reviewId: 'review-42' }),
      transitioned('deploy', 'TEST_DEPLOYED', 'reviewer', { headSha: shaA, reviewerId: 'reviewer', reviewId: 'review-42', testDeploymentId: 'deploy-42' }),
    ])

    expect(view).toMatchObject({
      source: 'control-plane', taskKey: taskId, taskSlug: 'ship-autonomous-lifecycle', state: 'TEST_DEPLOYED',
      currentRole: 'deployment', nextTransition: 'ACCEPTANCE_QA',
      evidence: { headSha: shaA, authorId: 'author', reviewerId: 'reviewer', reviewId: 'review-42', testDeploymentId: 'deploy-42' },
    })
    expect(view.integrityWarnings).toBeUndefined()
  })

  it('surfaces stale evidence and non-independent reviewer identity without treating either as a Dashboard authorization decision', () => {
    const view = projectAutonomousLifecycle('LOCAL-42', title, 'Working', [
      created(),
      transitioned('pr', 'PR_OPEN', 'author', { headSha: shaA, baseSha: shaB, pullRequestUrl: 'https://example.test/pr/42', authorId: 'author' }),
      transitioned('review', 'INDEPENDENT_REVIEW', 'author', { headSha: shaB, reviewerId: 'author', reviewId: 'review-42' }),
    ])

    expect(view.integrityWarnings).toEqual(expect.arrayContaining([
      expect.stringContaining('stale evidence head'),
      'reviewer identity matches implementation author',
    ]))
  })

  it('distinguishes a true human wait from capacity/recovery interrupts and clears it only on its recorded resume state', () => {
    const waiting = projectAutonomousLifecycle('LOCAL-42', title, 'Working', [
      created(),
      transitioned('implementing', 'IMPLEMENTING', 'author'),
      transitioned('human', 'WAITING_HUMAN', 'operator', { reason: 'acceptance decision required' }),
    ])
    expect(waiting.interrupt).toMatchObject({ state: 'WAITING_HUMAN', resumesTo: 'IMPLEMENTING', requiresHuman: true, reason: 'acceptance decision required' })

    const resumed = projectAutonomousLifecycle('LOCAL-42', title, 'Working', [
      created(),
      transitioned('implementing', 'IMPLEMENTING', 'author'),
      transitioned('human', 'WAITING_HUMAN', 'operator', { reason: 'acceptance decision required' }),
      transitioned('resume', 'IMPLEMENTING', 'author'),
    ])
    expect(resumed.state).toBe('IMPLEMENTING')
    expect(resumed.interrupt).toBeUndefined()
  })
})
