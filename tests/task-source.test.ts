import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { TaskSource } from '../src/task-source/index.ts'
import { resolveTaskSourceAgentTool, TaskSourceRegistry } from '../src/task-source/index.ts'

describe('TaskSource Agent tool compatibility', () => {
  it('adapts a legacy executeRaw-only provider to the GraphQL Agent tool contract', async () => {
    const executeRaw = vi.fn(async () => ({ data: { ok: true } }))
    const source = {
      kind: 'legacy-linear',
      context: () => ({ kind: 'legacy-linear', providerLabel: 'Legacy', projectLabel: 'ENG', projectRef: 'ENG' }),
      listBoardIssues: async () => [],
      listIssuesByStates: async () => [],
      getIssuesByNativeRefs: async () => [],
      executeRaw,
    } satisfies TaskSource

    const tool = resolveTaskSourceAgentTool(source)
    expect(tool).toMatchObject({ kind: 'graphql', name: 'legacy_linear_graphql' })
    if (tool?.kind !== 'graphql') throw new Error('Expected legacy GraphQL adapter')
    await expect(tool.execute('query Viewer { viewer { id } }', { limit: 1 })).resolves.toEqual({ data: { ok: true } })
    expect(executeRaw).toHaveBeenCalledWith('query Viewer { viewer { id } }', { limit: 1 }, undefined)
  })
})

describe('TaskSourceRegistry workspace aliases', () => {
  it('resolves the stable current-workspace scope to a durable Catalog project id', () => {
    const registry = new TaskSourceRegistry(new Context())
    const source = stubSource('local')
    const disposeSource = registry.scope('project-uuid').register(source)
    const disposeAlias = registry.aliasScope('current-workspace', 'project-uuid')

    expect(registry.requireScoped('current-workspace', 'local')).toBe(source)
    expect(registry.scopedKinds('current-workspace')).toEqual(['local'])

    disposeAlias()
    expect(() => registry.requireScoped('current-workspace', 'local')).toThrow('known: none')
    disposeSource()
  })

  it('rejects alias cycles and permits a new owner after disposal', () => {
    const registry = new TaskSourceRegistry(new Context())
    const dispose = registry.aliasScope('current-workspace', 'project-one')
    expect(() => registry.aliasScope('project-one', 'current-workspace')).toThrow('cycle')
    dispose()
    expect(() => registry.aliasScope('current-workspace', 'project-two')).not.toThrow()
  })
})

function stubSource(kind: string): TaskSource {
  return {
    kind,
    context: () => ({ kind, providerLabel: kind, projectLabel: 'Test', projectRef: 'test' }),
    listBoardIssues: async () => [],
    listIssuesByStates: async () => [],
    getIssuesByNativeRefs: async () => [],
  }
}
