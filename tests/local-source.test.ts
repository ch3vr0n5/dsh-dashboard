import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalTaskSource } from '../src/local/source.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('LocalTaskSource', () => {
  it('keeps a rejected User Test transition in its prior active state and exposes every diagnostic', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-dashboard-local-'))
    temporaryDirectories.push(directory)
    const source = new LocalTaskSource({ storePath: join(directory, 'tasks.json') }, () => ({
      projectId: 'personal', states: ['In Progress', 'Human Review', 'User Test', 'Done'], activeStates: ['In Progress', 'Human Review'], terminalStates: ['Done'],
    }))
    const task = await source.createTask({ title: 'Gate this card', state: 'Human Review' })

    await expect(source.updateTask(task.nativeRef, { title: 'Must not partially apply', state: 'User Test' })).rejects.toMatchObject({
      dashboardCode: 'local.userTestEvidenceMissing',
      message: expect.stringContaining('- automated review: missing'),
    })
    expect((await source.getIssuesByNativeRefs([task.nativeRef]))[0]).toMatchObject({ title: 'Gate this card', state: { name: 'Human Review' } })
  })

  it('allows User Test only after evidence is appended through the supported Local tool and preserves attempts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-dashboard-local-'))
    temporaryDirectories.push(directory)
    const source = new LocalTaskSource({ storePath: join(directory, 'tasks.json') }, () => ({
      projectId: 'personal', states: ['In Progress', 'Human Review', 'User Test', 'Done'], activeStates: ['In Progress', 'Human Review'], terminalStates: ['Done'],
    }))
    const task = await source.createTask({ title: 'Evidence-backed card', state: 'Human Review' })
    const sha = 'a'.repeat(40)
    const evidence = {
      commitSha: sha,
      automatedTests: { result: 'passed' as const, timestamp: '2026-08-26T06:00:00Z', commitSha: sha },
      automatedReview: { result: 'passed' as const, timestamp: '2026-08-26T06:05:00Z', commitSha: sha, unresolvedBlockingFindings: 0 },
      pullRequest: { url: 'https://github.com/ch3vr0n5/dsh-dashboard/pull/2', number: 2, headSha: sha, timestamp: '2026-08-26T06:10:00Z' },
      deployment: { deployedSha: sha, timestamp: '2026-08-26T06:15:00Z' },
      liveVerification: { result: 'passed' as const, timestamp: '2026-08-26T06:20:00Z', url: 'http://127.0.0.1:3000/health', verifiedSha: sha },
    }
    await source.recordUserTestEvidence(task.nativeRef, { commitSha: sha, automatedTests: evidence.automatedTests }, { role: 'qa', workspaceSha: sha })
    await source.recordUserTestEvidence(task.nativeRef, { commitSha: sha, automatedReview: evidence.automatedReview }, { role: 'review', workspaceSha: sha })
    await source.recordUserTestEvidence(task.nativeRef, {
      commitSha: sha,
      pullRequest: evidence.pullRequest,
      deployment: evidence.deployment,
      liveVerification: evidence.liveVerification,
    }, { role: 'delivery', workspaceSha: sha })

    const transitioned = await source.updateTask(task.nativeRef, { state: 'User Test' })
    expect(transitioned).toMatchObject({ state: { name: 'User Test' }, userTestGate: { ready: true, attempts: [{ attempt: 1, commitSha: sha }] } })
    expect(JSON.stringify(await readFile(source.storePath, 'utf8'))).not.toContain('secret')
  })

  it('serializes concurrent mutations and persists create, edit, state, and delete operations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-dashboard-local-'))
    temporaryDirectories.push(directory)
    const storePath = join(directory, 'tasks.json')
    const routing = () => ({
      projectId: 'personal',
      contextLabel: 'Personal',
      states: ['Backlog', 'Todo', 'In Progress', 'Done'],
      activeStates: ['Todo', 'In Progress'],
      terminalStates: ['Done'],
    })
    const source = new LocalTaskSource({ storePath }, routing)

    const [first, second] = await Promise.all([
      source.createTask({ title: 'Write integration test', state: 'Backlog', priority: 2 }),
      source.createTask({ title: 'Document local tasks', state: 'Todo' }),
    ])

    expect(new Set([first.identifier, second.identifier])).toEqual(new Set(['LOCAL-1', 'LOCAL-2']))
    expect(source.context()).toMatchObject({ providerLabel: 'Local', projectLabel: 'Personal' })
    expect(source.capabilities()).toMatchObject({ create: true, update: true, delete: true })

    const updated = await source.updateTask(first.nativeRef, {
      title: 'Write loaded-plugin integration test',
      description: 'Run through Harness.',
      state: 'In Progress',
      priority: null,
    })
    expect(updated).toMatchObject({ title: 'Write loaded-plugin integration test', state: { name: 'In Progress' } })
    expect(updated.priority).toBeUndefined()

    const reloaded = new LocalTaskSource({ storePath }, routing)
    expect(await reloaded.listBoardIssues()).toHaveLength(2)
    expect(await reloaded.getIssuesByNativeRefs([first.nativeRef])).toMatchObject([{ description: 'Run through Harness.' }])

    expect(await reloaded.deleteTask(second.nativeRef)).toBe(true)
    expect(await reloaded.deleteTask(second.nativeRef)).toBe(false)
    expect(await reloaded.listBoardIssues()).toHaveLength(1)
    expect(JSON.parse(await readFile(storePath, 'utf8'))).toMatchObject({ version: 1, projects: { personal: { nextNumber: 3 } } })
  })

  it('serializes mutations from separate project sources that share one store file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-dashboard-local-'))
    temporaryDirectories.push(directory)
    const storePath = join(directory, 'tasks.json')
    const sourceFor = (projectId: string) => new LocalTaskSource({ storePath }, () => ({
      projectId,
      states: ['Todo', 'Done'],
      activeStates: ['Todo'],
      terminalStates: ['Done'],
    }))
    const alpha = sourceFor('alpha')
    const beta = sourceFor('beta')

    await Promise.all([
      alpha.createTask({ title: 'Alpha task' }),
      beta.createTask({ title: 'Beta task' }),
    ])

    expect(await sourceFor('alpha').listBoardIssues()).toMatchObject([{ title: 'Alpha task' }])
    expect(await sourceFor('beta').listBoardIssues()).toMatchObject([{ title: 'Beta task' }])
    expect(JSON.parse(await readFile(storePath, 'utf8'))).toMatchObject({
      projects: { alpha: { nextNumber: 2 }, beta: { nextNumber: 2 } },
    })
  })

  it('rejects states outside the current workflow instead of silently inventing columns', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-dashboard-local-'))
    temporaryDirectories.push(directory)
    const source = new LocalTaskSource({ storePath: join(directory, 'tasks.json') }, () => ({
      projectId: 'personal',
      states: ['Todo', 'Done'],
      activeStates: ['Todo'],
      terminalStates: ['Done'],
    }))

    await expect(source.createTask({ title: 'Invalid state', state: 'Unknown' })).rejects.toThrow('not declared')
  })

  it('rejects a stale human edit without overwriting a newer Agent update', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-dashboard-local-'))
    temporaryDirectories.push(directory)
    const source = new LocalTaskSource({ storePath: join(directory, 'tasks.json') }, () => ({
      projectId: 'personal', states: ['Todo', 'In Progress', 'Done'], activeStates: ['Todo', 'In Progress'], terminalStates: ['Done'],
    }))
    const opened = await source.createTask({ title: 'Original title', description: 'Original workpad', state: 'Todo' })
    if (opened.updatedAt === undefined) throw new Error('Local tasks must expose an updatedAt revision')
    const agentUpdated = await source.updateTask(opened.nativeRef, { description: 'Agent workpad', state: 'In Progress' })

    await expect(source.updateTask(opened.nativeRef, {
      title: 'Human title', expectedUpdatedAt: opened.updatedAt,
    })).rejects.toMatchObject({
      dashboardCode: 'local.taskChanged',
      message: 'Local task changed since the editor was opened; close and reopen it to load the latest version',
    })

    expect((await source.getIssuesByNativeRefs([opened.nativeRef]))[0]).toMatchObject({
      title: 'Original title', description: 'Agent workpad', state: { name: 'In Progress' }, updatedAt: agentUpdated.updatedAt,
    })
  })

  it('decodes hostile project keys without mutating the project-map prototype', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-dashboard-local-'))
    temporaryDirectories.push(directory)
    const storePath = join(directory, 'tasks.json')
    await writeFile(storePath, JSON.stringify({
      version: 1,
      projects: { ['__proto__']: { nextNumber: 1, issues: [] }, personal: { nextNumber: 1, issues: [] } },
    }))
    const source = new LocalTaskSource({ storePath }, () => ({
      projectId: 'personal', states: ['Todo', 'Done'], activeStates: ['Todo'], terminalStates: ['Done'],
    }))

    expect(await source.listBoardIssues()).toEqual([])
    await source.createTask({ title: 'Prototype-safe task' })
    const persisted = JSON.parse(await readFile(storePath, 'utf8')) as { projects: Record<string, unknown> }
    expect(Object.hasOwn(persisted.projects, '__proto__')).toBe(true)
    expect(Object.hasOwn(persisted.projects, 'personal')).toBe(true)
  })
})
