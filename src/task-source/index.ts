/** Public TaskSource capability seam for remote trackers and Host-local tasks. */

import { Context, Service } from '@deepseek-ai/cordis'
import type { TaskIssue, TaskSourceContext } from '../domain/issue.ts'
import type { UserTestEvidencePatch } from '../lifecycle/user-test-evidence.ts'

export type { IssueBlocker, IssueState, TaskIssue, TaskSourceContext } from '../domain/issue.ts'

export interface TaskSourceCredentialStatus {
  readonly ref: string
  readonly label: string
  readonly configured: boolean
  readonly source?: string
  readonly writable: boolean
}

export interface CreateTaskInput {
  readonly title: string
  readonly description?: string
  readonly state?: string
  readonly priority?: number
}

export interface UpdateTaskInput {
  readonly title?: string
  readonly description?: string | null
  readonly state?: string
  readonly priority?: number | null
  /** Optional compare-and-swap token used by human editors. */
  readonly expectedUpdatedAt?: string
}

export interface TaskSourceCapabilities {
  readonly create: boolean
  readonly update: boolean
  readonly delete: boolean
  readonly states: readonly string[]
  readonly userTestEvidence?: boolean
}

export type TaskSourceAgentTool =
  | {
      readonly kind: 'graphql'
      readonly name: string
      readonly description: string
      execute(query: string, variables: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<unknown>
    }
  | {
      readonly kind: 'rest'
      readonly name: string
      readonly description: string
      execute(request: {
        readonly method: string
        readonly path: string
        readonly query?: Readonly<Record<string, unknown>>
        readonly body?: unknown
      }, signal?: AbortSignal): Promise<unknown>
    }
  | {
      readonly kind: 'task-mutation'
      readonly name: string
      readonly description: string
      execute(request: {
        readonly operation: 'get' | 'update' | 'record-user-test-evidence'
        readonly nativeRef: string
        readonly title?: string
        readonly description?: string | null
        readonly state?: string
        readonly priority?: number | null
        readonly evidence?: UserTestEvidencePatch
      }, signal?: AbortSignal): Promise<unknown>
    }

/** Read-side and scheduler-side operations implemented by one task provider. */
export interface TaskSource {
  readonly kind: string
  context(): TaskSourceContext
  listBoardIssues(signal?: AbortSignal): Promise<readonly TaskIssue[]>
  listIssuesByStates(states: readonly string[], signal?: AbortSignal): Promise<readonly TaskIssue[]>
  getIssuesByNativeRefs(nativeRefs: readonly string[], signal?: AbortSignal): Promise<readonly TaskIssue[]>
  credentialStatuses?(): Promise<readonly TaskSourceCredentialStatus[]>
  capabilities?(): TaskSourceCapabilities
  createTask?(input: CreateTaskInput, signal?: AbortSignal): Promise<TaskIssue>
  updateTask?(nativeRef: string, input: UpdateTaskInput, signal?: AbortSignal): Promise<TaskIssue>
  recordUserTestEvidence?(nativeRef: string, input: UserTestEvidencePatch, signal?: AbortSignal): Promise<TaskIssue>
  deleteTask?(nativeRef: string, signal?: AbortSignal): Promise<boolean>
  agentTool?(): TaskSourceAgentTool
  /** @deprecated Implement `agentTool()` for new providers. */
  executeRaw?(query: string, variables: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<unknown>
}

/** Minimal source lookup contract consumed by one project orchestrator. */
export interface TaskSourceResolver {
  require(kind: string): TaskSource
  readonly kinds: readonly string[]
}

/** Preserve the pre-0.2 GraphQL seam while external providers migrate to `agentTool()`. */
export function resolveTaskSourceAgentTool(source: TaskSource): TaskSourceAgentTool | undefined {
  const explicit = source.agentTool?.()
  if (explicit !== undefined || source.executeRaw === undefined) return explicit
  const legacyExecute = source.executeRaw.bind(source)
  const slug = source.kind.trim().toLocaleLowerCase('en-US').replaceAll(/[^a-z0-9_]+/gu, '_').replace(/^_+|_+$/gu, '')
  return {
    kind: 'graphql',
    name: `${slug === '' ? 'task_source' : slug}_graphql`,
    description: `Call the ${source.kind} GraphQL API through the configured dsh-dashboard task source. Authentication is supplied by the Host.`,
    execute: async (query, variables, signal) => await legacyExecute(query, variables, signal),
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    dashboardTaskSources: TaskSourceRegistry
  }
}

/** Layer-owned registry; later providers register without importing the Linear implementation. */
export class TaskSourceRegistry extends Service {
  private readonly sources = new Map<string, TaskSource>()
  private readonly scopedSources = new Map<string, Map<string, TaskSource>>()
  private readonly scopeAliases = new Map<string, string>()

  constructor(ctx: Context) {
    super(ctx, 'dashboardTaskSources')
  }

  /** Register one provider kind for the caller fiber. */
  register(source: TaskSource): () => void {
    if (this.sources.has(source.kind)) {
      throw new Error(`dsh-dashboard: task source ${JSON.stringify(source.kind)} is already registered`)
    }
    return this.ctx.effect(() => {
      this.sources.set(source.kind, source)
      return () => { this.sources.delete(source.kind) }
    }, `dashboardTaskSources.register(${JSON.stringify(source.kind)})`)
  }

  /** Create a project-owned view whose built-ins cannot collide with another project. */
  scope(id: string): ScopedTaskSourceRegistry {
    const key = normalizeScope(id)
    return new ScopedTaskSourceRegistry(this, key)
  }

  /**
   * Keep a stable integration-facing scope name pointed at a durable Catalog
   * project id. Catalog project ids survive restarts, while extensions such as
   * gibb-services intentionally address the selected workspace by role.
   */
  aliasScope(alias: string, target: string): () => void {
    const aliasKey = normalizeScope(alias)
    const targetKey = normalizeScope(target)
    if (aliasKey === targetKey) return () => undefined
    if (this.scopeAliases.has(aliasKey)) {
      throw new Error(`dsh-dashboard: task source scope alias ${JSON.stringify(aliasKey)} is already registered`)
    }

    let cursor = targetKey
    const visited = new Set([aliasKey])
    while (this.scopeAliases.has(cursor)) {
      if (visited.has(cursor)) {
        throw new Error(`dsh-dashboard: task source scope alias ${JSON.stringify(aliasKey)} would create a cycle`)
      }
      visited.add(cursor)
      cursor = this.scopeAliases.get(cursor)!
    }
    if (cursor === aliasKey) {
      throw new Error(`dsh-dashboard: task source scope alias ${JSON.stringify(aliasKey)} would create a cycle`)
    }

    this.scopeAliases.set(aliasKey, targetKey)
    return () => {
      if (this.scopeAliases.get(aliasKey) === targetKey) this.scopeAliases.delete(aliasKey)
    }
  }

  /** Resolve one provider kind or fail with the current catalog. */
  require(kind: string): TaskSource {
    const source = this.sources.get(kind)
    if (source !== undefined) return source
    throw new Error(`dsh-dashboard: task source ${JSON.stringify(kind)} is not registered (known: ${this.kinds.join(', ') || 'none'})`)
  }

  /** Registered provider ids in deterministic order. */
  get kinds(): readonly string[] {
    return [...this.sources.keys()].sort()
  }

  registerScoped(scope: string, source: TaskSource): () => void {
    let sources = this.scopedSources.get(scope)
    if (sources === undefined) {
      sources = new Map()
      this.scopedSources.set(scope, sources)
    }
    if (sources.has(source.kind)) {
      throw new Error(`dsh-dashboard: task source ${JSON.stringify(source.kind)} is already registered for scope ${JSON.stringify(scope)}`)
    }
    sources.set(source.kind, source)
    return () => {
      const current = this.scopedSources.get(scope)
      current?.delete(source.kind)
      if (current?.size === 0) this.scopedSources.delete(scope)
    }
  }

  requireScoped(scope: string, kind: string): TaskSource {
    const resolvedScope = this.resolveScope(scope)
    const source = this.scopedSources.get(resolvedScope)?.get(kind) ?? this.sources.get(kind)
    if (source !== undefined) return source
    const known = this.scopedKinds(scope)
    throw new Error(`dsh-dashboard: task source ${JSON.stringify(kind)} is not registered for scope ${JSON.stringify(scope)} (known: ${known.join(', ') || 'none'})`)
  }

  scopedKinds(scope: string): readonly string[] {
    const resolvedScope = this.resolveScope(scope)
    return [...new Set([
      ...this.sources.keys(),
      ...(this.scopedSources.get(resolvedScope)?.keys() ?? []),
    ])].sort()
  }

  /** Stable aliases and durable ids available to trusted integration tools. */
  get scopeIds(): readonly string[] {
    return [...new Set([
      ...this.scopedSources.keys(),
      ...this.scopeAliases.keys(),
    ])].sort()
  }

  private resolveScope(scope: string): string {
    let current = normalizeScope(scope)
    const visited = new Set<string>()
    while (this.scopeAliases.has(current)) {
      if (visited.has(current)) {
        throw new Error(`dsh-dashboard: task source scope alias cycle at ${JSON.stringify(current)}`)
      }
      visited.add(current)
      current = this.scopeAliases.get(current)!
    }
    return current
  }
}

function normalizeScope(scope: string): string {
  const key = scope.trim()
  if (key === '') throw new Error('dsh-dashboard: task source scope id must not be empty')
  return key
}

/** Project-local resolver backed by the one Harness service registry. */
export class ScopedTaskSourceRegistry implements TaskSourceResolver {
  constructor(
    private readonly registry: TaskSourceRegistry,
    readonly scope: string,
  ) {}

  register(source: TaskSource): () => void {
    return this.registry.registerScoped(this.scope, source)
  }

  require(kind: string): TaskSource {
    return this.registry.requireScoped(this.scope, kind)
  }

  get kinds(): readonly string[] {
    return this.registry.scopedKinds(this.scope)
  }
}
