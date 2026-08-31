/**
 * Pure proposal-to-dispatch boundary for Personal READY tasks.
 *
 * This module deliberately knows nothing about a proposal ledger or a concrete
 * dispatcher. Both are represented by small, fake-friendly value/function
 * contracts so the authorization boundary can be tested without I/O.
 */

export const PERSONAL_DISPATCH_PROPOSAL_KIND = 'personal-dispatch' as const
export const DEFAULT_PROPOSAL_TTL_MS = 5 * 60 * 1_000

export interface CanonicalReadyTask {
  readonly taskId: string
  readonly domain: 'personal' | 'work'
  readonly state: 'READY' | string
  readonly repo: string | null
  readonly base: string | null
  readonly version: number | null
}

type ValidPersonalReadyTask = CanonicalReadyTask & {
  readonly domain: 'personal'
  readonly state: 'READY'
  readonly repo: string
  readonly base: string
  readonly version: number
}

export interface PersonalDispatchProposal {
  readonly kind: typeof PERSONAL_DISPATCH_PROPOSAL_KIND
  readonly domain: 'personal'
  readonly taskId: string
  readonly version: number
  readonly repo: string
  readonly base: string
  readonly expiresAt: number
}

export interface AcceptedPersonalDispatchProposal extends PersonalDispatchProposal {
  readonly status: 'accepted'
}

/** The only capability needed from the eventual concrete dispatcher. */
export interface PersonalDispatcherAdapter<TResult = void> {
  dispatch(proposal: PersonalDispatchProposal): TResult | PromiseLike<TResult>
}

export type ProposalRejectionCode =
  | 'invalid-task'
  | 'invalid-ttl'
  | 'domain-mismatch'
  | 'state-mismatch'
  | 'binding-mismatch'
  | 'stale-proposal'
  | 'not-accepted'
  | 'acceptance-mismatch'

export class ProposalDispatchError extends Error {
  readonly code: ProposalRejectionCode

  constructor(code: ProposalRejectionCode, message: string) {
    super(message)
    this.name = 'ProposalDispatchError'
    this.code = code
  }
}

/**
 * Derive one, and only one, bounded proposal from a canonical READY task.
 * `nowEpochMs` is explicit to keep this function deterministic and pure.
 */
export function derivePersonalDispatchProposal(
  task: CanonicalReadyTask,
  nowEpochMs: number,
  ttlMs = DEFAULT_PROPOSAL_TTL_MS,
): PersonalDispatchProposal {
  validateClock(nowEpochMs)
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new ProposalDispatchError('invalid-ttl', 'proposal TTL must be a positive safe integer')
  const validTask = validateReadyTask(task)
  const expiresAt = nowEpochMs + ttlMs
  if (!Number.isSafeInteger(expiresAt)) throw new ProposalDispatchError('invalid-ttl', 'proposal expiry exceeds the safe integer range')
  return {
    kind: PERSONAL_DISPATCH_PROPOSAL_KIND,
    domain: 'personal',
    taskId: validTask.taskId,
    version: validTask.version,
    repo: validTask.repo,
    base: validTask.base,
    expiresAt,
  }
}

export interface DispatchAcceptedProposalInput<TResult = void> {
  readonly task: CanonicalReadyTask
  readonly proposal: PersonalDispatchProposal
  readonly acceptedProposal: AcceptedPersonalDispatchProposal | undefined
  readonly dispatcher: PersonalDispatcherAdapter<TResult>
  readonly nowEpochMs: number
}

/**
 * Validate the task, proposal, and explicit acceptance before dispatching.
 * The dispatcher is not touched on any rejected path.
 */
export async function dispatchAcceptedPersonalProposal<TResult>(
  input: DispatchAcceptedProposalInput<TResult>,
): Promise<TResult> {
  validateClock(input.nowEpochMs)
  const validTask = validateReadyTask(input.task)
  validateProposalBinding(validTask, input.proposal)
  if (input.proposal.expiresAt <= input.nowEpochMs) {
    throw new ProposalDispatchError('stale-proposal', 'proposal has expired')
  }
  const accepted = input.acceptedProposal
  if (accepted === undefined || accepted.status !== 'accepted') {
    throw new ProposalDispatchError('not-accepted', 'an explicitly accepted proposal is required')
  }
  if (!sameProposal(input.proposal, accepted)) {
    throw new ProposalDispatchError('acceptance-mismatch', 'accepted proposal does not exactly match the dispatch proposal')
  }
  return await input.dispatcher.dispatch(input.proposal)
}

function validateReadyTask(task: CanonicalReadyTask): ValidPersonalReadyTask {
  if (task.domain !== 'personal') throw new ProposalDispatchError('domain-mismatch', 'only Personal tasks may be dispatched')
  if (task.state !== 'READY') throw new ProposalDispatchError('state-mismatch', 'only READY tasks may be dispatched')
  const { taskId, repo, base, version } = task
  if (typeof taskId !== 'string' || taskId.trim() === '' || typeof repo !== 'string' || repo.trim() === '' || typeof base !== 'string' || base.trim() === '' || !Number.isSafeInteger(version) || (version as number) <= 0) {
    throw new ProposalDispatchError('invalid-task', 'READY task requires non-null taskId, repo, base, and positive version')
  }
  return task as ValidPersonalReadyTask
}

function validateProposalBinding(task: ValidPersonalReadyTask, proposal: PersonalDispatchProposal): void {
  if (proposal.domain !== 'personal' || proposal.kind !== PERSONAL_DISPATCH_PROPOSAL_KIND) {
    throw new ProposalDispatchError('domain-mismatch', 'proposal is not a Personal dispatch proposal')
  }
  if (proposal.taskId !== task.taskId || proposal.version !== task.version || proposal.repo !== task.repo || proposal.base !== task.base) {
    throw new ProposalDispatchError('binding-mismatch', 'proposal does not exactly bind to the READY task')
  }
  if (!Number.isSafeInteger(proposal.expiresAt)) throw new ProposalDispatchError('binding-mismatch', 'proposal expiry is invalid')
}

function sameProposal(left: PersonalDispatchProposal, right: AcceptedPersonalDispatchProposal): boolean {
  return right.kind === left.kind && right.domain === left.domain && right.taskId === left.taskId && right.version === left.version && right.repo === left.repo && right.base === left.base && right.expiresAt === left.expiresAt
}

function validateClock(nowEpochMs: number): void {
  if (!Number.isSafeInteger(nowEpochMs) || nowEpochMs < 0) throw new ProposalDispatchError('invalid-task', 'clock value must be a non-negative safe integer')
}
