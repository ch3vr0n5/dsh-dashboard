import { describe, expect, it } from 'vitest'
import {
  appendUserTestEvidence,
  evaluateUserTestGate,
  parseUserTestEvidencePatch,
  type UserTestEvidenceLedger,
  type UserTestEvidencePatch,
} from '../src/lifecycle/user-test-evidence.ts'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const times = {
  tests: '2026-08-26T10:00:00.000Z',
  review: '2026-08-26T10:05:00.000Z',
  pr: '2026-08-26T10:10:00.000Z',
  deployment: '2026-08-26T10:15:00.000Z',
  live: '2026-08-26T10:20:00.000Z',
}
const now = new Date('2026-08-26T11:00:00.000Z')

function completePatch(sha = SHA_A): UserTestEvidencePatch {
  return {
    commitSha: sha,
    automatedTests: { result: 'passed', timestamp: times.tests, commitSha: sha },
    automatedReview: { result: 'passed', timestamp: times.review, commitSha: sha, unresolvedBlockingFindings: 0 },
    pullRequest: { url: 'https://github.com/ch3vr0n5/dsh-dashboard/pull/2', number: 2, headSha: sha, timestamp: times.pr },
    deployment: { deployedSha: sha, timestamp: times.deployment },
    liveVerification: { result: 'passed', timestamp: times.live, url: 'http://127.0.0.1:3000/health', verifiedSha: sha },
  }
}

function ledgerFor(patch = completePatch()): UserTestEvidenceLedger {
  const ledger = appendUserTestEvidence(undefined, patch, now)
  if (typeof ledger === 'string') throw new Error(ledger)
  return ledger
}

describe('User Test transition evidence', () => {
  it('reports every missing prerequisite without relying on card prose', () => {
    expect(evaluateUserTestGate(undefined)).toEqual({
      ready: false,
      attempts: [],
      diagnostics: [
        'automated tests: missing',
        'automated review: missing',
        'pull request: missing',
        'deployment: missing',
        'live verification: missing',
      ],
    })
  })

  it('accepts only passing, ordered evidence for one exact PR-head commit', () => {
    expect(evaluateUserTestGate(ledgerFor())).toMatchObject({ ready: true, diagnostics: [], currentAttempt: { commitSha: SHA_A } })
  })

  it('reports failed tests, failed review, unresolved blockers, and failed live verification together', () => {
    const patch = completePatch()
    const ledger = ledgerFor({
      ...patch,
      automatedTests: { ...patch.automatedTests!, result: 'failed' },
      automatedReview: { ...patch.automatedReview!, result: 'failed', unresolvedBlockingFindings: 3 },
      liveVerification: { ...patch.liveVerification!, result: 'failed' },
    })
    expect(evaluateUserTestGate(ledger).diagnostics).toEqual(expect.arrayContaining([
      expect.stringContaining('automated tests: result is failed'),
      expect.stringContaining('automated review: result is failed'),
      expect.stringContaining('3 unresolved blocking finding'),
      expect.stringContaining('live verification: result is failed'),
    ]))
  })

  it('rejects every SHA mismatch and contradictory component commit', () => {
    const ledger = structuredClone(ledgerFor()) as unknown as { attempts: Array<{ revisions: Array<Record<string, any>> }> }
    const evidence = ledger.attempts[0]!.revisions[0]!
    evidence.automatedTests.commitSha = SHA_B
    evidence.automatedReview.commitSha = SHA_B
    evidence.pullRequest.headSha = SHA_B
    evidence.deployment.deployedSha = SHA_B
    evidence.liveVerification.verifiedSha = SHA_B
    expect(evaluateUserTestGate(ledger).diagnostics.join('\n')).toContain(`automatedTests.commitSha ${SHA_B} does not exactly match evidence.commitSha ${SHA_A}`)
  })

  it('rejects stale ordering and secret-bearing or malformed URLs', () => {
    const stale = completePatch()
    const ledger = ledgerFor({
      ...stale,
      deployment: { ...stale.deployment!, timestamp: '2026-08-26T09:00:00.000Z' },
      liveVerification: { ...stale.liveVerification!, timestamp: '2026-08-26T08:00:00.000Z' },
    })
    expect(evaluateUserTestGate(ledger).diagnostics).toEqual(expect.arrayContaining([
      'deployment: timestamp predates the PR-head observation and is stale',
      'live verification: timestamp predates deployment and is stale',
    ]))
    expect(parseUserTestEvidencePatch({
      commitSha: SHA_A,
      liveVerification: { result: 'passed', timestamp: times.live, url: 'https://user:secret@example.test/health?token=secret', verifiedSha: SHA_A },
    }, now)).toBe('liveVerification.url must not contain credentials, query parameters, or fragments')
  })

  it('preserves revision history, starts a clean attempt for a revised commit, and rejects writes to superseded commits', () => {
    const testsOnly: UserTestEvidencePatch = { commitSha: SHA_A, automatedTests: completePatch().automatedTests! }
    const first = appendUserTestEvidence(undefined, testsOnly, now)
    if (typeof first === 'string') throw new Error(first)
    const reviewed = appendUserTestEvidence(first, { commitSha: SHA_A, automatedReview: completePatch().automatedReview! }, new Date('2026-08-26T11:01:00Z'))
    if (typeof reviewed === 'string') throw new Error(reviewed)
    expect(reviewed.attempts[0]?.revisions).toHaveLength(2)
    expect(reviewed.attempts[0]?.revisions[0]?.automatedReview).toBeUndefined()
    const revised = appendUserTestEvidence(reviewed, { commitSha: SHA_B, automatedTests: { ...completePatch(SHA_B).automatedTests! } }, new Date('2026-08-26T11:02:00Z'))
    if (typeof revised === 'string') throw new Error(revised)
    expect(revised.attempts).toHaveLength(2)
    expect(evaluateUserTestGate(revised).diagnostics).toEqual(expect.arrayContaining(['automated review: missing', 'pull request: missing']))
    expect(appendUserTestEvidence(revised, testsOnly, new Date('2026-08-26T11:03:00Z'))).toContain('is stale')
  })

  it('rejects malformed, future, and mismatched evidence before it can be stored', () => {
    expect(parseUserTestEvidencePatch({ commitSha: 'short', automatedTests: {} }, now)).toContain('40-character Git SHA')
    expect(parseUserTestEvidencePatch({
      commitSha: SHA_A,
      automatedTests: { result: 'passed', timestamp: 'not-a-date', commitSha: SHA_A },
    }, now)).toContain('valid ISO timestamp')
    expect(parseUserTestEvidencePatch({
      commitSha: SHA_A,
      automatedTests: { result: 'passed', timestamp: '2027-08-26T10:00:00Z', commitSha: SHA_A },
    }, now)).toContain('five minutes in the future')
    expect(parseUserTestEvidencePatch({
      commitSha: SHA_A,
      deployment: { deployedSha: SHA_B, timestamp: times.deployment },
    }, now)).toContain('does not exactly match')
  })
})
