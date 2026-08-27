/** Production transport for the deliberately read-only control-plane seam. */

import { request as httpRequest } from 'node:http'
import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import {
  CONTROL_PLANE_READ_TIMEOUT_MS,
  type AutonomousDomain,
  type ControlPlaneReadAdapter,
  type ControlPlaneTaskRead,
  type ControlPlaneTaskReference,
} from './autonomous.ts'

export const MAX_CONTROL_PLANE_RESPONSE_BYTES = 1_048_576

export interface ControlPlaneTransportConfig {
  /** HTTPS base URL, ending before the fixed control-plane route. */
  readonly endpoint?: string
  /** Absolute filesystem path to a local Unix-domain HTTP socket. */
  readonly socketPath?: string
  /** Credential reference resolved for every request; its value is never retained. */
  readonly credentialRef: string
  /** The one tenancy domain this Dashboard instance may project. */
  readonly domain: AutonomousDomain
  /** Per-request transport bound. The projector also independently bounds reads. */
  readonly timeoutMs?: number
}

export interface ControlPlaneAdapterOptions {
  readonly fetchImpl?: typeof globalThis.fetch
  readonly maxResponseBytes?: number
}

/**
 * Construct a GET-only adapter. The raw JSON is intentionally passed to the
 * existing strict projector; this transport does not normalize or repair it.
 */
export function createControlPlaneReadAdapter(
  credentials: Pick<CredentialProvider, 'resolve'>,
  config: ControlPlaneTransportConfig,
  options: ControlPlaneAdapterOptions = {},
): ControlPlaneReadAdapter {
  const target = validateControlPlaneTransport(config)
  credentialRef(config.credentialRef)
  const timeoutMs = config.timeoutMs ?? CONTROL_PLANE_READ_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) {
    throw new Error('dsh-dashboard: control-plane timeout must be between 1 and 30000ms')
  }
  const maxResponseBytes = options.maxResponseBytes ?? MAX_CONTROL_PLANE_RESPONSE_BYTES
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > MAX_CONTROL_PLANE_RESPONSE_BYTES) {
    throw new Error('dsh-dashboard: control-plane response limit is invalid')
  }

  return {
    async readTask(reference, signal) {
      if (reference.domain !== config.domain) throw new Error('control-plane task domain is not configured')
      const requestSignal = boundedSignal(signal, timeoutMs)
      try {
        const resolved = await abortable(Promise.resolve().then(async () => await credentials.resolve(credentialRef(config.credentialRef))), requestSignal.signal)
        if (resolved === undefined) throw new Error('control-plane credential is unavailable')
        const path = controlPlanePath(reference.taskId)
        const raw = target.kind === 'https'
          ? await requestHttps(target.url, path, resolved.value, requestSignal.signal, maxResponseBytes, options.fetchImpl ?? globalThis.fetch)
          : await requestSocket(target.socketPath, path, resolved.value, requestSignal.signal, maxResponseBytes)
        return JSON.parse(raw) as ControlPlaneTaskRead
      } catch (error) {
        if (requestSignal.signal.aborted) throw requestSignal.signal.reason ?? new Error('control-plane request aborted')
        // Do not include URLs, response bodies, credential references, or secrets in diagnostics.
        throw new Error('control-plane read request failed')
      } finally {
        requestSignal.dispose()
      }
    },
  }
}

export function validateControlPlaneTransport(config: ControlPlaneTransportConfig): { readonly kind: 'https', readonly url: URL } | { readonly kind: 'socket', readonly socketPath: string } {
  if (config.domain !== 'personal' && config.domain !== 'work') throw new Error('dsh-dashboard: control-plane domain must be personal or work')
  if (typeof config.credentialRef !== 'string' || config.credentialRef.trim() === '') throw new Error('dsh-dashboard: control-plane credential reference is required')
  const hasEndpoint = config.endpoint !== undefined
  const hasSocket = config.socketPath !== undefined
  if (hasEndpoint === hasSocket) throw new Error('dsh-dashboard: configure exactly one control-plane endpoint or socketPath')
  if (hasSocket) {
    const socketPath = config.socketPath!
    if (!socketPath.startsWith('/') || socketPath.includes('\u0000') || socketPath.split('/').some(part => part === '.' || part === '..')) {
      throw new Error('dsh-dashboard: control-plane socketPath must be an absolute safe Unix socket path')
    }
    return { kind: 'socket', socketPath }
  }
  let url: URL
  try {
    url = new URL(config.endpoint!)
  } catch {
    throw new Error('dsh-dashboard: control-plane endpoint is invalid')
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('dsh-dashboard: control-plane endpoint must be credential-free HTTPS without query or fragment')
  }
  return { kind: 'https', url }
}

function controlPlanePath(taskId: string): string {
  if (typeof taskId !== 'string' || taskId.trim() === '') throw new Error('control-plane task id is invalid')
  return `/control-plane/v1/tasks/${encodeURIComponent(taskId)}`
}

function boundedSignal(parent: AbortSignal | undefined, timeoutMs: number): { readonly signal: AbortSignal, readonly dispose: () => void } {
  const controller = new AbortController()
  const abort = () => controller.abort(parent?.reason ?? new Error('control-plane request aborted'))
  if (parent?.aborted) abort()
  else parent?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('control-plane request timed out')), timeoutMs)
  return { signal: controller.signal, dispose: () => { clearTimeout(timer); parent?.removeEventListener('abort', abort) } }
}

async function requestHttps(url: URL, path: string, secret: string, signal: AbortSignal, maxBytes: number, fetchImpl: typeof globalThis.fetch): Promise<string> {
  const target = new URL(url)
  target.pathname = `${url.pathname.replace(/\/+$/u, '')}${path}`
  let response: Response
  try {
    response = await abortable(fetchImpl(target, {
      method: 'GET', redirect: 'error', headers: { accept: 'application/json', authorization: `Bearer ${secret}` }, signal,
    }), signal)
  } catch {
    throw new Error('request failed')
  }
  if (response.status !== 200 || response.headers.get('content-type') !== 'application/json') throw new Error('invalid response')
  const length = response.headers.get('content-length')
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maxBytes)) throw new Error('response too large')
  return await abortable(readBoundedResponse(response.body, maxBytes, signal), signal)
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('control-plane request aborted'))
    signal.addEventListener('abort', abort, { once: true })
    void operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

async function requestSocket(socketPath: string, path: string, secret: string, signal: AbortSignal, maxBytes: number): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const request = httpRequest({ socketPath, path, method: 'GET', headers: { accept: 'application/json', authorization: `Bearer ${secret}` } }, response => {
      if (response.statusCode !== 200 || response.headers['content-type'] !== 'application/json') { response.resume(); reject(new Error('invalid response')); return }
      const length = response.headers['content-length']
      if (length !== undefined && (!/^\d+$/u.test(String(length)) || Number(length) > maxBytes)) { response.resume(); reject(new Error('response too large')); return }
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > maxBytes) { request.destroy(new Error('response too large')); return }
        chunks.push(chunk)
      })
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      response.on('error', () => reject(new Error('response failed')))
    })
    const abort = () => request.destroy(signal.reason instanceof Error ? signal.reason : new Error('request aborted'))
    signal.addEventListener('abort', abort, { once: true })
    request.once('error', () => reject(new Error('request failed')))
    request.once('close', () => signal.removeEventListener('abort', abort))
    request.end()
  })
}

async function readBoundedResponse(body: ReadableStream<Uint8Array> | null, maxBytes: number, signal: AbortSignal): Promise<string> {
  if (body === null) throw new Error('response body is missing')
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      if (signal.aborted) throw signal.reason
      const { done, value } = await reader.read()
      if (done) return new TextDecoder().decode(concat(chunks, size))
      size += value.byteLength
      if (size > maxBytes) { await reader.cancel(); throw new Error('response too large') }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
}

function concat(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength }
  return result
}
