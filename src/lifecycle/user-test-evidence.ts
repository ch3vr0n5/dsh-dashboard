/** Structured, append-only evidence required before a Local card may enter User Test. */

const SHA_PATTERN = /^[0-9a-f]{40}$/u
const FUTURE_TOLERANCE_MS = 5 * 60_000

export interface CommitResultEvidence {
  readonly result: 'passed' | 'failed'
  readonly timestamp: string
  readonly commitSha: string
}

export interface AutomatedReviewEvidence extends CommitResultEvidence {
  readonly unresolvedBlockingFindings: number
}

export interface PullRequestEvidence {
  readonly url: string
  readonly number: number
  readonly headSha: string
  /** Time at which the PR head was read from the provider. */
  readonly timestamp: string
}

export interface DeploymentEvidence {
  readonly deployedSha: string
  readonly timestamp: string
}

export interface LiveVerificationEvidence {
  readonly result: 'passed' | 'failed'
  readonly timestamp: string
  readonly url: string
  readonly verifiedSha: string
}

export interface UserTestEvidenceSnapshot {
  readonly automatedTests?: CommitResultEvidence
  readonly automatedReview?: AutomatedReviewEvidence
  readonly pullRequest?: PullRequestEvidence
  readonly deployment?: DeploymentEvidence
  readonly liveVerification?: LiveVerificationEvidence
}

export type UserTestEvidenceComponent = keyof UserTestEvidenceSnapshot
export type UserTestEvidenceRole = 'qa' | 'review' | 'delivery'

/** Host-derived authority; this is never accepted from an Agent/RPC payload. */
export interface UserTestEvidenceAuthority {
  readonly role: UserTestEvidenceRole
  readonly workspaceSha: string
}

export interface UserTestEvidenceRevision extends UserTestEvidenceSnapshot {
  readonly revision: number
  readonly recordedAt: string
  readonly authorities: Readonly<Partial<Record<UserTestEvidenceComponent, UserTestEvidenceAuthority>>>
}

export interface UserTestEvidenceAttempt {
  readonly attempt: number
  readonly commitSha: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly revisions: readonly UserTestEvidenceRevision[]
}

export interface UserTestEvidenceLedger {
  readonly version: 1
  readonly attempts: readonly UserTestEvidenceAttempt[]
}

export interface UserTestEvidencePatch extends UserTestEvidenceSnapshot {
  readonly commitSha: string
}

export interface UserTestGateView {
  readonly ready: boolean
  readonly diagnostics: readonly string[]
  readonly currentAttempt?: UserTestEvidenceAttempt
  readonly attempts: readonly UserTestEvidenceAttempt[]
}

/** Parse an untrusted RPC/tool payload and reject malformed or secret-bearing evidence. */
export function parseUserTestEvidencePatch(value: unknown, now = new Date()): UserTestEvidencePatch | string {
  if (!isObject(value)) return 'evidence must be an object'
  const commitSha = readSha(value.commitSha)
  if (commitSha === undefined) return 'evidence.commitSha must be a lowercase, full 40-character Git SHA'
  const keys = ['automatedTests', 'automatedReview', 'pullRequest', 'deployment', 'liveVerification'] as const
  if (!keys.some(key => value[key] !== undefined)) return `evidence for ${commitSha} must include at least one evidence component`

  const automatedTests = value.automatedTests === undefined ? undefined : readCommitResult(value.automatedTests, 'automatedTests', now)
  if (typeof automatedTests === 'string') return automatedTests
  const automatedReview = value.automatedReview === undefined ? undefined : readAutomatedReview(value.automatedReview, now)
  if (typeof automatedReview === 'string') return automatedReview
  const pullRequest = value.pullRequest === undefined ? undefined : readPullRequest(value.pullRequest, now)
  if (typeof pullRequest === 'string') return pullRequest
  const deployment = value.deployment === undefined ? undefined : readDeployment(value.deployment, now)
  if (typeof deployment === 'string') return deployment
  const liveVerification = value.liveVerification === undefined ? undefined : readLiveVerification(value.liveVerification, now)
  if (typeof liveVerification === 'string') return liveVerification

  for (const [name, sha] of [
    ['automatedTests.commitSha', automatedTests?.commitSha],
    ['automatedReview.commitSha', automatedReview?.commitSha],
    ['pullRequest.headSha', pullRequest?.headSha],
    ['deployment.deployedSha', deployment?.deployedSha],
    ['liveVerification.verifiedSha', liveVerification?.verifiedSha],
  ] as const) {
    if (sha !== undefined && sha !== commitSha) return `${name} ${sha} does not exactly match evidence.commitSha ${commitSha}`
  }
  return {
    commitSha,
    ...(automatedTests === undefined ? {} : { automatedTests }),
    ...(automatedReview === undefined ? {} : { automatedReview }),
    ...(pullRequest === undefined ? {} : { pullRequest }),
    ...(deployment === undefined ? {} : { deployment }),
    ...(liveVerification === undefined ? {} : { liveVerification }),
  }
}

/** Append a revision to the current commit attempt, or begin a new revision attempt. */
export function appendUserTestEvidence(
  ledgerValue: unknown,
  patch: UserTestEvidencePatch,
  authority: UserTestEvidenceAuthority,
  now = new Date(),
): UserTestEvidenceLedger | string {
  if (authority.workspaceSha !== patch.commitSha) {
    return `host-derived workspace SHA ${authority.workspaceSha} does not match evidence commit ${patch.commitSha}`
  }
  const unauthorized = evidenceComponents(patch).filter(component => !roleOwnsComponent(authority.role, component))
  if (unauthorized.length > 0) {
    return `lifecycle role ${authority.role} cannot record ${unauthorized.join(', ')}`
  }
  const ledger = ledgerValue === undefined ? { version: 1 as const, attempts: [] } : readLedger(ledgerValue)
  if (typeof ledger === 'string') return ledger
  const current = ledger.attempts.at(-1)
  if (current !== undefined && current.commitSha !== patch.commitSha
    && ledger.attempts.some(attempt => attempt.commitSha === patch.commitSha)) {
    return `evidence for ${patch.commitSha} is stale; attempt ${current.attempt} for newer commit ${current.commitSha} is current`
  }
  const recordedAt = now.toISOString()
  const previous = current?.commitSha === patch.commitSha ? current.revisions.at(-1) : undefined
  const { commitSha: _commitSha, ...components } = patch
  const revision: UserTestEvidenceRevision = {
    ...(previous?.automatedTests === undefined ? {} : { automatedTests: previous.automatedTests }),
    ...(previous?.automatedReview === undefined ? {} : { automatedReview: previous.automatedReview }),
    ...(previous?.pullRequest === undefined ? {} : { pullRequest: previous.pullRequest }),
    ...(previous?.deployment === undefined ? {} : { deployment: previous.deployment }),
    ...(previous?.liveVerification === undefined ? {} : { liveVerification: previous.liveVerification }),
    ...components,
    revision: (previous?.revision ?? 0) + 1,
    recordedAt,
    authorities: {
      ...(previous?.authorities ?? {}),
      ...Object.fromEntries(evidenceComponents(patch).map(component => [component, authority])),
    },
  }
  const attempts = [...ledger.attempts]
  if (current?.commitSha === patch.commitSha) {
    attempts[attempts.length - 1] = { ...current, updatedAt: recordedAt, revisions: [...current.revisions, revision] }
  } else {
    attempts.push({ attempt: (current?.attempt ?? 0) + 1, commitSha: patch.commitSha, createdAt: recordedAt, updatedAt: recordedAt, revisions: [revision] })
  }
  return { version: 1, attempts }
}

/** Evaluate all prerequisites so one rejection tells a worker exactly what to repair. */
export function evaluateUserTestGate(ledgerValue: unknown): UserTestGateView {
  if (ledgerValue === undefined) {
    return {
      ready: false,
      diagnostics: ['automated tests: missing', 'automated review: missing', 'pull request: missing', 'deployment: missing', 'live verification: missing'],
      attempts: [],
    }
  }
  const ledger = readLedger(ledgerValue)
  if (typeof ledger === 'string') return { ready: false, diagnostics: [`evidence ledger: ${ledger}`], attempts: [] }
  const currentAttempt = ledger.attempts.at(-1)
  if (currentAttempt === undefined) {
    return { ready: false, diagnostics: ['automated tests: missing', 'automated review: missing', 'pull request: missing', 'deployment: missing', 'live verification: missing'], attempts: [] }
  }
  const evidence = currentAttempt.revisions.at(-1)
  const sha = currentAttempt.commitSha
  const diagnostics: string[] = []
  checkCommitResult('automated tests', evidence?.automatedTests, sha, diagnostics)
  checkCommitResult('automated review', evidence?.automatedReview, sha, diagnostics)
  if (evidence?.automatedReview !== undefined && evidence.automatedReview.unresolvedBlockingFindings !== 0) {
    diagnostics.push(`automated review: ${evidence.automatedReview.unresolvedBlockingFindings} unresolved blocking finding(s); resolve them and record a new passing review`)
  }
  if (evidence?.pullRequest === undefined) diagnostics.push('pull request: missing')
  else if (evidence.pullRequest.headSha !== sha) diagnostics.push(`pull request: head SHA ${evidence.pullRequest.headSha} does not match current evidence commit ${sha}`)
  if (evidence?.deployment === undefined) diagnostics.push('deployment: missing')
  else if (evidence.deployment.deployedSha !== sha) diagnostics.push(`deployment: deployed SHA ${evidence.deployment.deployedSha} does not match PR head SHA ${sha}`)
  if (evidence?.liveVerification === undefined) diagnostics.push('live verification: missing')
  else {
    if (evidence.liveVerification.result !== 'passed') diagnostics.push('live verification: result is failed; verify the deployed artifact and record a passing result')
    if (evidence.liveVerification.verifiedSha !== sha) diagnostics.push(`live verification: verified SHA ${evidence.liveVerification.verifiedSha} does not match PR head SHA ${sha}`)
  }
  checkAuthority('automatedTests', 'qa', evidence?.authorities.automatedTests, sha, diagnostics)
  checkAuthority('automatedReview', 'review', evidence?.authorities.automatedReview, sha, diagnostics)
  checkAuthority('pullRequest', 'delivery', evidence?.authorities.pullRequest, sha, diagnostics)
  checkAuthority('deployment', 'delivery', evidence?.authorities.deployment, sha, diagnostics)
  checkAuthority('liveVerification', 'delivery', evidence?.authorities.liveVerification, sha, diagnostics)
  if (evidence?.pullRequest !== undefined && evidence.automatedTests !== undefined && evidence.automatedTests.timestamp > evidence.pullRequest.timestamp) {
    diagnostics.push('automated tests: timestamp is after the PR-head observation; rerun tests before recording the PR evidence')
  }
  if (evidence?.pullRequest !== undefined && evidence.automatedReview !== undefined && evidence.automatedReview.timestamp > evidence.pullRequest.timestamp) {
    diagnostics.push('automated review: timestamp is after the PR-head observation; record a fresh PR-head observation after review')
  }
  if (evidence?.pullRequest !== undefined && evidence.deployment !== undefined && evidence.deployment.timestamp < evidence.pullRequest.timestamp) {
    diagnostics.push('deployment: timestamp predates the PR-head observation and is stale')
  }
  if (evidence?.deployment !== undefined && evidence.liveVerification !== undefined && evidence.liveVerification.timestamp < evidence.deployment.timestamp) {
    diagnostics.push('live verification: timestamp predates deployment and is stale')
  }
  return { ready: diagnostics.length === 0, diagnostics, currentAttempt, attempts: ledger.attempts }
}

function checkCommitResult(label: string, value: CommitResultEvidence | undefined, sha: string, diagnostics: string[]): void {
  if (value === undefined) diagnostics.push(`${label}: missing`)
  else {
    if (value.result !== 'passed') diagnostics.push(`${label}: result is failed; record a passing result for ${sha}`)
    if (value.commitSha !== sha) diagnostics.push(`${label}: commit ${value.commitSha} does not match PR head SHA ${sha}`)
  }
}

function checkAuthority(
  component: UserTestEvidenceComponent,
  role: UserTestEvidenceRole,
  authority: UserTestEvidenceAuthority | undefined,
  sha: string,
  diagnostics: string[],
): void {
  if (authority === undefined) diagnostics.push(`${component}: missing host-derived ${role} provenance`)
  else {
    if (authority.role !== role) diagnostics.push(`${component}: recorded by ${authority.role}, expected ${role}`)
    if (authority.workspaceSha !== sha) diagnostics.push(`${component}: host-derived workspace SHA ${authority.workspaceSha} does not match ${sha}`)
  }
}

function readLedger(value: unknown): UserTestEvidenceLedger | string {
  if (!isObject(value) || value.version !== 1 || !Array.isArray(value.attempts)) return 'missing or malformed (expected version 1 with an attempts array)'
  const attempts: UserTestEvidenceAttempt[] = []
  for (let index = 0; index < value.attempts.length; index += 1) {
    const attempt = readAttempt(value.attempts[index], index)
    if (typeof attempt === 'string') return attempt
    attempts.push(attempt)
  }
  return { version: 1, attempts }
}

function readAttempt(value: unknown, index: number): UserTestEvidenceAttempt | string {
  if (!isObject(value)) return `attempt ${index + 1} is malformed`
  const attempt = typeof value.attempt === 'number' && Number.isInteger(value.attempt) && value.attempt === index + 1 ? value.attempt : undefined
  const commitSha = readSha(value.commitSha)
  const createdAt = readTimestamp(value.createdAt)
  const updatedAt = readTimestamp(value.updatedAt)
  if (attempt === undefined || commitSha === undefined || createdAt === undefined || updatedAt === undefined || !Array.isArray(value.revisions) || value.revisions.length === 0) {
    return `attempt ${index + 1} is malformed`
  }
  const revisions: UserTestEvidenceRevision[] = []
  for (let revisionIndex = 0; revisionIndex < value.revisions.length; revisionIndex += 1) {
    const revision = readRevision(value.revisions[revisionIndex], revisionIndex, commitSha)
    if (typeof revision === 'string') return `attempt ${index + 1} ${revision}`
    revisions.push(revision)
  }
  return { attempt, commitSha, createdAt, updatedAt, revisions }
}

function readRevision(value: unknown, index: number, commitSha: string): UserTestEvidenceRevision | string {
  if (!isObject(value) || value.revision !== index + 1) return `revision ${index + 1} is malformed`
  const recordedAt = readTimestamp(value.recordedAt)
  if (recordedAt === undefined) return `revision ${index + 1} has an invalid recordedAt timestamp`
  const patch = parseUserTestEvidencePatch({ ...value, commitSha }, new Date(8640000000000000))
  if (typeof patch === 'string') return `revision ${index + 1}: ${patch}`
  const authorities = readAuthorities(value.authorities)
  if (typeof authorities === 'string') return `revision ${index + 1}: ${authorities}`
  return { ...patch, revision: index + 1, recordedAt, authorities }
}

function readAuthorities(value: unknown): Readonly<Partial<Record<UserTestEvidenceComponent, UserTestEvidenceAuthority>>> | string {
  if (!isObject(value)) return 'authorities must be a host-derived object'
  const result: Partial<Record<UserTestEvidenceComponent, UserTestEvidenceAuthority>> = {}
  for (const component of ['automatedTests', 'automatedReview', 'pullRequest', 'deployment', 'liveVerification'] as const) {
    const raw = value[component]
    if (raw === undefined) continue
    if (!isObject(raw) || (raw.role !== 'qa' && raw.role !== 'review' && raw.role !== 'delivery')) return `authorities.${component}.role is invalid`
    const workspaceSha = readSha(raw.workspaceSha)
    if (workspaceSha === undefined) return `authorities.${component}.workspaceSha must be a lowercase, full 40-character Git SHA`
    result[component] = { role: raw.role, workspaceSha }
  }
  return result
}

function evidenceComponents(patch: UserTestEvidencePatch): UserTestEvidenceComponent[] {
  return (['automatedTests', 'automatedReview', 'pullRequest', 'deployment', 'liveVerification'] as const)
    .filter(component => patch[component] !== undefined)
}

function roleOwnsComponent(role: UserTestEvidenceRole, component: UserTestEvidenceComponent): boolean {
  if (role === 'qa') return component === 'automatedTests'
  if (role === 'review') return component === 'automatedReview'
  return component === 'pullRequest' || component === 'deployment' || component === 'liveVerification'
}

function readCommitResult(value: unknown, field: string, now: Date): CommitResultEvidence | string {
  if (!isObject(value) || (value.result !== 'passed' && value.result !== 'failed')) return `${field}.result must be passed or failed`
  const timestamp = checkedTimestamp(value.timestamp, `${field}.timestamp`, now)
  if (!timestamp.ok) return timestamp.error
  const commitSha = readSha(value.commitSha)
  if (commitSha === undefined) return `${field}.commitSha must be a lowercase, full 40-character Git SHA`
  return { result: value.result, timestamp: timestamp.value, commitSha }
}

function readAutomatedReview(value: unknown, now: Date): AutomatedReviewEvidence | string {
  const base = readCommitResult(value, 'automatedReview', now)
  if (typeof base === 'string') return base
  if (!isObject(value) || typeof value.unresolvedBlockingFindings !== 'number' || !Number.isInteger(value.unresolvedBlockingFindings) || value.unresolvedBlockingFindings < 0) {
    return 'automatedReview.unresolvedBlockingFindings must be a non-negative integer'
  }
  return { ...base, unresolvedBlockingFindings: value.unresolvedBlockingFindings }
}

function readPullRequest(value: unknown, now: Date): PullRequestEvidence | string {
  if (!isObject(value)) return 'pullRequest must be an object'
  const url = checkedUrl(value.url, 'pullRequest.url', false)
  if (typeof url !== 'string' || !url.startsWith('https://')) return typeof url === 'string' ? 'pullRequest.url must use HTTPS' : url
  const number = typeof value.number === 'number' && Number.isInteger(value.number) && value.number > 0 ? value.number : undefined
  if (number === undefined) return 'pullRequest.number must be a positive integer'
  const pathNumber = Number(new URL(url).pathname.match(/\/(\d+)\/?$/u)?.[1])
  if (pathNumber !== number) return `pullRequest.url does not end with pull request number ${number}`
  const headSha = readSha(value.headSha)
  if (headSha === undefined) return 'pullRequest.headSha must be a lowercase, full 40-character Git SHA'
  const timestamp = checkedTimestamp(value.timestamp, 'pullRequest.timestamp', now)
  if (!timestamp.ok) return timestamp.error
  return { url, number, headSha, timestamp: timestamp.value }
}

function readDeployment(value: unknown, now: Date): DeploymentEvidence | string {
  if (!isObject(value)) return 'deployment must be an object'
  const deployedSha = readSha(value.deployedSha)
  if (deployedSha === undefined) return 'deployment.deployedSha must be a lowercase, full 40-character Git SHA'
  const timestamp = checkedTimestamp(value.timestamp, 'deployment.timestamp', now)
  if (!timestamp.ok) return timestamp.error
  return { deployedSha, timestamp: timestamp.value }
}

function readLiveVerification(value: unknown, now: Date): LiveVerificationEvidence | string {
  if (!isObject(value) || (value.result !== 'passed' && value.result !== 'failed')) return 'liveVerification.result must be passed or failed'
  const timestamp = checkedTimestamp(value.timestamp, 'liveVerification.timestamp', now)
  if (!timestamp.ok) return timestamp.error
  const url = checkedUrl(value.url, 'liveVerification.url', true)
  if (typeof url !== 'string' || (!url.startsWith('http://') && !url.startsWith('https://'))) return url
  const verifiedSha = readSha(value.verifiedSha)
  if (verifiedSha === undefined) return 'liveVerification.verifiedSha must be a lowercase, full 40-character Git SHA'
  return { result: value.result, timestamp: timestamp.value, url, verifiedSha }
}

function checkedTimestamp(value: unknown, field: string, now: Date): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly error: string } {
  const timestamp = readTimestamp(value)
  if (timestamp === undefined) return { ok: false, error: `${field} must be a valid ISO timestamp` }
  if (Date.parse(timestamp) > now.getTime() + FUTURE_TOLERANCE_MS) return { ok: false, error: `${field} must not be more than five minutes in the future` }
  return { ok: true, value: timestamp }
}

function checkedUrl(value: unknown, field: string, allowHttp: boolean): string {
  if (typeof value !== 'string') return `${field} must be an absolute ${allowHttp ? 'HTTP(S)' : 'HTTPS'} URL`
  try {
    const url = new URL(value)
    if ((!allowHttp && url.protocol !== 'https:') || (allowHttp && url.protocol !== 'http:' && url.protocol !== 'https:')) return `${field} has an unsupported protocol`
    if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return `${field} must not contain credentials, query parameters, or fragments`
    return url.toString()
  } catch {
    return `${field} must be an absolute ${allowHttp ? 'HTTP(S)' : 'HTTPS'} URL`
  }
}

function readSha(value: unknown): string | undefined {
  return typeof value === 'string' && SHA_PATTERN.test(value) ? value : undefined
}

function readTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return undefined
  return new Date(value).toISOString()
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
