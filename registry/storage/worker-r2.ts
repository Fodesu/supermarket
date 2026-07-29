import {
  IndeterminateRemoteMutationError,
  type BlobBackend,
} from './contracts'

/**
 * R2 access mediated by the Writer Worker outbound handler. This is used in
 * Cloudflare Containers so S3 credentials never enter the container.
 */
export class WorkerR2BlobBackend implements BlobBackend {
  constructor(
    private readonly baseURL: string,
    private readonly fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = fetch,
    private readonly requestTimeoutMs = Number(process.env.REGISTRY_R2_REQUEST_TIMEOUT_MS || 60_000),
  ) {
    if (!/^http:\/\/[a-z0-9.-]+$/i.test(baseURL)) throw new Error('REGISTRY_BLOBS_URL must be an HTTP virtual hostname')
  }
  async get(key: string) {
    const response = await this.request(`objects/${encodeURIComponent(key)}`, 'GET')
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`Worker R2 read failed (${response.status} ${response.statusText}): ${key}`)
    return new Uint8Array(await response.arrayBuffer())
  }
  async put(key: string, value: Uint8Array) {
    const response = await this.request(`objects/${encodeURIComponent(key)}`, 'PUT', value, undefined, this.isMutable(key))
    if (!response.ok) throw new IndeterminateRemoteMutationError(`Worker R2 write outcome is unknown (${response.status} ${response.statusText}): ${key}`)
  }
  async putConditional(key: string, value: Uint8Array, expectedVersion: string | null) {
    const response = await this.request(`objects/${encodeURIComponent(key)}`, 'PUT', value, expectedVersion === null
      ? { 'if-none-match': '*' }
      : { 'if-match': `"${normalizeETag(expectedVersion)}"` })
    if (response.status === 409 || response.status === 412) return null
    if (!response.ok) throw new IndeterminateRemoteMutationError(`Conditional Worker R2 write outcome is unknown (${response.status} ${response.statusText}): ${key}`)
    const version = normalizeETag(response.headers.get('etag'))
    if (!version) throw new Error(`Conditional Worker R2 write returned no ETag: ${key}`)
    return version
  }
  async list(prefix: string) {
    return this.listObjects(prefix)
  }
  async listPrefixes(prefix: string) {
    return this.listObjects(prefix, '/')
  }
  private async listObjects(prefix: string, delimiter?: string) {
    const keys: string[] = []
    let cursor: string | undefined
    do {
      const query = new URLSearchParams({ prefix })
      if (cursor) query.set('cursor', cursor)
      if (delimiter) query.set('delimiter', delimiter)
      const response = await this.request(`list?${query}`, 'GET')
      if (!response.ok) throw new Error(`Worker R2 list failed (${response.status} ${response.statusText}): ${prefix}`)
      const page = await response.json() as { keys: string[]; cursor?: string }
      keys.push(...page.keys)
      cursor = page.cursor
    } while (cursor)
    return [...new Set(keys)].sort()
  }
  private isMutable(key: string) {
    return /^skill-registries\/[^/]+\/state\.json$/.test(key)
  }
  private async request(
    path: string,
    method: 'GET' | 'PUT',
    value?: Uint8Array,
    headers?: HeadersInit,
    mutable = false,
  ) {
    try {
      const requestHeaders = new Headers(headers)
      const target = mutable ? process.env.REGISTRY_STATE_URL : this.baseURL
      if (mutable) {
        const token = process.env.REGISTRY_WRITER_TOKEN
        if (!target || !token) throw new Error('Mutable Registry writes require REGISTRY_STATE_URL and REGISTRY_WRITER_TOKEN')
        requestHeaders.set('x-registry-writer-token', token)
      }
      return await this.fetcher(new URL(path, `${target}/`).toString(), {
        method, headers: requestHeaders, body: value?.slice().buffer as ArrayBuffer | undefined,
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      })
    } catch (error) {
      if (method !== 'GET') throw new IndeterminateRemoteMutationError(`Worker R2 ${method} outcome is unknown: ${path}`, { cause: error })
      throw error
    }
  }
}

function normalizeETag(value: unknown) {
  return typeof value === 'string'
    ? value.trim().replace(/^W\//, '').replace(/^"|"$/g, '')
    : ''
}
