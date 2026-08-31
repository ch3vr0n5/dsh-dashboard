import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_PROPOSAL_TTL_MS,
  ProposalDispatchError,
  derivePersonalDispatchProposal,
  dispatchAcceptedPersonalProposal,
  type AcceptedPersonalDispatchProposal,
  type CanonicalReadyTask,
} from '../stacks/lifecycle-supervisor/index.ts'

const task: CanonicalReadyTask = { taskId: 'task-17', domain: 'personal', state: 'READY', repo: 'personal/app', base: 'main@abc', version: 7 }
const now = 1_700_000_000_000

function accepted(overrides: Partial<AcceptedPersonalDispatchProposal> = {}): AcceptedPersonalDispatchProposal {
  return { ...derivePersonalDispatchProposal(task, now), status: 'accepted', ...overrides }
}

describe('Personal lifecycle supervisor proposal-to-dispatch contract', () => {
  it('derives exactly one bounded Personal proposal from a canonical READY task', () => {
    expect(derivePersonalDispatchProposal(task, now)).toEqual({
      kind: 'personal-dispatch', domain: 'personal', taskId: 'task-17', version: 7,
      repo: 'personal/app', base: 'main@abc', expiresAt: now + DEFAULT_PROPOSAL_TTL_MS,
    })
  })

  it.each([
    ['domain', { domain: 'work' as const }, 'domain-mismatch'],
    ['state', { state: 'CLAIMED' }, 'state-mismatch'],
    ['repo', { repo: null }, 'invalid-task'],
    ['base', { base: null }, 'invalid-task'],
    ['version', { version: null }, 'invalid-task'],
  ] as const)('rejects a task with a %s mismatch or missing binding', (_name, changes, code) => {
    expect(() => derivePersonalDispatchProposal({ ...task, ...changes }, now)).toThrowError(expect.objectContaining({ code }))
  })

  it('requires explicit exact acceptance before invoking the dispatcher', async () => {
    const dispatch = vi.fn(async () => 'dispatched')
    const proposal = derivePersonalDispatchProposal(task, now)
    await expect(dispatchAcceptedPersonalProposal({ task, proposal, acceptedProposal: undefined, dispatcher: { dispatch }, nowEpochMs: now })).rejects.toMatchObject({ code: 'not-accepted' })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it.each([
    ['task', { taskId: 'other' }, 'binding-mismatch'],
    ['version', { version: 8 }, 'binding-mismatch'],
    ['repo', { repo: 'other/app' }, 'binding-mismatch'],
    ['base', { base: 'main@def' }, 'binding-mismatch'],
  ] as const)('rejects an exact-binding mismatch for %s', async (_name, changes, _code) => {
    const dispatch = vi.fn()
    const proposal = derivePersonalDispatchProposal(task, now)
    await expect(dispatchAcceptedPersonalProposal({ task, proposal, acceptedProposal: accepted(changes), dispatcher: { dispatch }, nowEpochMs: now })).rejects.toMatchObject({ code: 'acceptance-mismatch' })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('rejects stale proposals at and after expiry', async () => {
    const dispatch = vi.fn()
    const proposal = derivePersonalDispatchProposal(task, now, 10)
    for (const currentTime of [now + 10, now + 11]) {
      await expect(dispatchAcceptedPersonalProposal({ task, proposal, acceptedProposal: { ...proposal, status: 'accepted' }, dispatcher: { dispatch }, nowEpochMs: currentTime })).rejects.toMatchObject({ code: 'stale-proposal' })
    }
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('rejects an accepted proposal whose expiry is not the proposal expiry', async () => {
    const dispatch = vi.fn()
    const proposal = derivePersonalDispatchProposal(task, now)
    await expect(dispatchAcceptedPersonalProposal({
      task, proposal, acceptedProposal: { ...proposal, expiresAt: proposal.expiresAt + 1, status: 'accepted' },
      dispatcher: { dispatch }, nowEpochMs: now,
    })).rejects.toMatchObject({ code: 'acceptance-mismatch' })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('rejects proposal domain and task state mismatches before dispatch', async () => {
    const dispatch = vi.fn()
    const proposal = derivePersonalDispatchProposal(task, now)
    await expect(dispatchAcceptedPersonalProposal({
      task, proposal: { ...proposal, domain: 'work' as 'personal' }, acceptedProposal: { ...proposal, status: 'accepted' },
      dispatcher: { dispatch }, nowEpochMs: now,
    })).rejects.toMatchObject({ code: 'domain-mismatch' })
    await expect(dispatchAcceptedPersonalProposal({
      task: { ...task, state: 'CLAIMED' }, proposal, acceptedProposal: { ...proposal, status: 'accepted' },
      dispatcher: { dispatch }, nowEpochMs: now,
    })).rejects.toMatchObject({ code: 'state-mismatch' })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('dispatches once only after all checks pass and returns the adapter result', async () => {
    const dispatch = vi.fn(async () => 'dispatched')
    const proposal = derivePersonalDispatchProposal(task, now)
    await expect(dispatchAcceptedPersonalProposal({ task, proposal, acceptedProposal: { ...proposal, status: 'accepted' }, dispatcher: { dispatch }, nowEpochMs: now + 1 })).resolves.toBe('dispatched')
    expect(dispatch).toHaveBeenCalledOnce()
    expect(dispatch).toHaveBeenCalledWith(proposal)
  })

  it('does not make infrastructure calls itself', async () => {
    const dispatch = vi.fn(async () => undefined)
    const proposal = derivePersonalDispatchProposal(task, now)
    await dispatchAcceptedPersonalProposal({ task, proposal, acceptedProposal: { ...proposal, status: 'accepted' }, dispatcher: { dispatch }, nowEpochMs: now })
    expect(dispatch).toHaveBeenCalledOnce()
  })
})
