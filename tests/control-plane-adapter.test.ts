import { describe, expect, it, vi } from 'vitest'
import {
  createControlPlaneReadAdapter,
  validateControlPlaneTransport,
} from '../src/lifecycle/control-plane-adapter.ts'
import { projectAutonomousLifecycle, type ControlPlaneTaskReference } from '../src/lifecycle/autonomous.ts'

const secret = 'never-log-this-token'
const reference: ControlPlaneTaskReference = {
  projectId: 'project', taskKey: 'task-42', taskSlug: 'secure-read', taskId: 'task-42-secure-read', domain: 'personal',
}

function credentials(value = secret) {
  return { resolve: vi.fn(async () => ({ value, source: 'test' })) }
}

function adapter(fetchImpl: typeof globalThis.fetch, overrides: Record<string, unknown> = {}) {
  return createControlPlaneReadAdapter(credentials(), {
    endpoint: 'https://control-plane.example.test/api', credentialRef: 'CONTROL_PLANE_TOKEN', domain: 'personal', timeoutMs: 100,
    ...overrides,
  }, { fetchImpl })
}

describe('control-plane production read adapter', () => {
  it('isolates Personal and Work before resolving credentials or sending a request', async () => {
    const resolve = vi.fn(async () => ({ value: secret, source: 'test' }))
    const fetchImpl = vi.fn<typeof globalThis.fetch>()
    const readAdapter = createControlPlaneReadAdapter({ resolve }, {
      endpoint: 'https://control-plane.example.test', credentialRef: 'CONTROL_PLANE_TOKEN', domain: 'personal',
    }, { fetchImpl })

    await expect(readAdapter.readTask({ ...reference, domain: 'work' })).rejects.toThrow('domain is not configured')
    expect(resolve).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('projects a valid Personal stream as Personal rather than the legacy Work default', () => {
    const read = {
      version: 1,
      events: [{
        streamVersion: 1,
        event: {
          schemaVersion: 'control-plane/v1', eventId: 'created', type: 'TASK_CREATED', taskId: reference.taskId, domain: 'personal',
          actor: { id: 'intake', domain: 'personal' }, occurredAt: '2026-08-27T00:00:00Z', payload: { title: 'Secure Read', initialState: 'IDEA' },
        },
      }],
    }
    expect(projectAutonomousLifecycle('task-42', 'Secure Read', 'Todo', read, undefined, 'personal')).toMatchObject({
      source: 'control-plane', domain: 'personal', state: 'IDEA',
    })
  })

  it('uses a GET-only Bearer request and exposes no write capability', async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      expect(String(input)).toBe('https://control-plane.example.test/api/control-plane/v1/tasks/task-42-secure-read')
      expect(init?.method).toBe('GET')
      expect(init?.redirect).toBe('error')
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${secret}`)
      return new Response('{"version":1,"events":[]}', { headers: { 'content-type': 'application/json' } })
    })
    const readAdapter = adapter(fetchImpl)
    await expect(readAdapter.readTask(reference)).resolves.toEqual({ version: 1, events: [] })
    expect('writeTask' in readAdapter).toBe(false)
    expect(Object.keys(readAdapter)).toEqual(['readTask'])
  })

  it('propagates malformed JSON only as a safe failure and lets the strict projector reject malformed shape', async () => {
    const malformed = adapter(vi.fn(async () => new Response('{not-json', { headers: { 'content-type': 'application/json' } })))
    await expect(malformed.readTask(reference)).rejects.toThrow('control-plane read request failed')

    const wrongShape = adapter(vi.fn(async () => new Response('{"version":1,"events":[],"extra":true}', { headers: { 'content-type': 'application/json' } })))
    const raw = await wrongShape.readTask(reference)
    expect(projectAutonomousLifecycle('task-42', 'Secure Read', 'Todo', raw, undefined, 'personal')).toMatchObject({
      source: 'corrupt-stream', domain: 'personal', integrityWarnings: [expect.stringContaining('unsupported field')],
    })
  })

  it('fails closed for an oversized body, incorrect content type, and never leaks the credential', async () => {
    const tooLarge = adapter(vi.fn(async () => new Response('{}', {
      headers: { 'content-type': 'application/json', 'content-length': '1048577' },
    })))
    const nonExactJson = adapter(vi.fn(async () => new Response('<html>', { headers: { 'content-type': 'application/json; charset=utf-8' } })))
    for (const readAdapter of [tooLarge, nonExactJson]) {
      await expect(readAdapter.readTask(reference)).rejects.toThrow('control-plane read request failed')
      await readAdapter.readTask(reference).catch(error => expect(String(error)).not.toContain(secret))
    }
    const unavailable = createControlPlaneReadAdapter({ resolve: vi.fn(async () => { throw new Error(secret) }) }, {
      endpoint: 'https://control-plane.example.test', credentialRef: 'CONTROL_PLANE_TOKEN', domain: 'personal',
    })
    await unavailable.readTask(reference).catch(error => expect(String(error)).not.toContain(secret))
  })

  it('accepts exactly HTTP 200 and rejects every other successful status', async () => {
    for (const status of [201, 202, 204]) {
      const readAdapter = adapter(vi.fn(async () => new Response(status === 204 ? null : '{"version":1,"events":[]}', {
        status, headers: { 'content-type': 'application/json' },
      })))
      await expect(readAdapter.readTask(reference)).rejects.toThrow('control-plane read request failed')
    }
  })

  it('aborts a hung transport at the configured timeout', async () => {
    let observed: AbortSignal | undefined
    const fetchImpl = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      observed = init?.signal ?? undefined
      return await new Promise<Response>(() => {})
    })
    const readAdapter = adapter(fetchImpl, { timeoutMs: 10 })
    await expect(readAdapter.readTask(reference)).rejects.toThrow('timed out')
    expect(observed?.aborted).toBe(true)
  })

  it('rejects unsafe endpoint and socket configurations without echoing sensitive URL content', () => {
    const invalid = [
      { endpoint: 'http://127.0.0.1:8080', credentialRef: 'CONTROL_PLANE_TOKEN', domain: 'personal' },
      { endpoint: 'https://user:password@control-plane.example.test', credentialRef: 'CONTROL_PLANE_TOKEN', domain: 'personal' },
      { endpoint: 'https://control-plane.example.test/path?token=bad', credentialRef: 'CONTROL_PLANE_TOKEN', domain: 'personal' },
      { endpoint: 'https://control-plane.example.test/path#secret', credentialRef: 'CONTROL_PLANE_TOKEN', domain: 'personal' },
      { socketPath: 'relative.sock', credentialRef: 'CONTROL_PLANE_TOKEN', domain: 'personal' },
      { socketPath: '/../tmp/control.sock', credentialRef: 'CONTROL_PLANE_TOKEN', domain: 'personal' },
      { endpoint: 'https://control-plane.example.test', socketPath: '/tmp/control.sock', credentialRef: 'CONTROL_PLANE_TOKEN', domain: 'personal' },
    ] as const
    for (const config of invalid) {
      expect(() => validateControlPlaneTransport(config)).toThrow(/dsh-dashboard:/u)
      try { validateControlPlaneTransport(config) } catch (error) { expect(String(error)).not.toContain('password') }
    }
  })
})
