import path from 'node:path'
import { LocalSkillRegistryStore } from '../../server/utils/local-skill-registry-store'
import {
  BlobSkillRegistryStore,
  IndeterminateRemoteMutationError,
  type BlobBackend,
  type SkillRegistryStore,
} from '../../server/utils/skill-registry-store'

export class S3BlobBackend implements BlobBackend {
  private readonly client: any
  constructor(
    client?: any,
    private readonly fetcher: typeof fetch = fetch,
    private readonly requestTimeoutMs = Number(process.env.REGISTRY_R2_REQUEST_TIMEOUT_MS || 60_000),
  ) {
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs < 1_000) {
      throw new Error('REGISTRY_R2_REQUEST_TIMEOUT_MS must be at least 1000ms')
    }
    if (client) {
      this.client = client
      return
    }
    const S3Client = (Bun as any).S3Client
    if (!S3Client) throw new Error('This Bun runtime does not provide S3Client')
    const accountID = process.env.R2_ACCOUNT_ID!
    this.client = new S3Client({
      accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      bucket: process.env.R2_BUCKET!, endpoint: process.env.R2_ENDPOINT || `https://${accountID}.r2.cloudflarestorage.com`,
    })
  }
  async get(key: string) {
    return this.withTimeout((async () => {
      const file = this.client.file(key)
      if (!await file.exists()) return null
      return new Uint8Array(await file.arrayBuffer())
    })(), `S3 read timed out: ${key}`)
  }
  async put(key: string, value: Uint8Array) {
    const response = await this.request(key, 'PUT', value)
    if (!response.ok) {
      throw new IndeterminateRemoteMutationError(`S3 write outcome is unknown (${response.status} ${response.statusText}): ${key}`)
    }
  }
  async delete(key: string) {
    const response = await this.request(key, 'DELETE')
    if (!response.ok && response.status !== 404) {
      throw new IndeterminateRemoteMutationError(`S3 delete outcome is unknown (${response.status} ${response.statusText}): ${key}`)
    }
  }
  async getVersioned(key: string) {
    const response = await this.request(key, 'GET')
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`Versioned S3 read failed (${response.status} ${response.statusText})`)
    const version = normalizeETag(response.headers.get('etag'))
    if (!version) throw new Error(`S3 object has no ETag: ${key}`)
    return { value: new Uint8Array(await response.arrayBuffer()), version }
  }
  async putConditional(key: string, value: Uint8Array, expectedVersion: string | null) {
    const response = await this.request(key, 'PUT', value, expectedVersion === null
      ? { 'if-none-match': '*' }
      : { 'if-match': `"${normalizeETag(expectedVersion)}"` })
    if (response.status === 409 || response.status === 412) return null
    if (!response.ok) {
      throw new IndeterminateRemoteMutationError(`Conditional S3 write outcome is unknown (${response.status} ${response.statusText}): ${key}`)
    }
    const version = normalizeETag(response.headers.get('etag'))
    if (!version) throw new Error(`Conditional S3 write returned no ETag: ${key}`)
    return version
  }
  private async request(key: string, method: 'GET' | 'PUT' | 'DELETE', value?: Uint8Array, headers?: HeadersInit) {
    const expiresIn = Math.max(60, Math.ceil(this.requestTimeoutMs / 1000) + 30)
    try {
      return await this.fetcher(this.client.presign(key, { method, expiresIn }), {
        method, headers,
        body: value?.slice().buffer as ArrayBuffer | undefined,
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      })
    } catch (error) {
      if (method !== 'GET') {
        throw new IndeterminateRemoteMutationError(`S3 ${method} outcome is unknown: ${key}`, { cause: error })
      }
      throw error
    }
  }
  private async withTimeout<T>(operation: Promise<T>, message: string): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(message)), this.requestTimeoutMs)
          timeout.unref?.()
        }),
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }
  async list(prefix: string) {
    const keys: string[] = []
    let continuationToken: string | undefined
    do {
      const result = await this.withTimeout<any>(
        this.client.list({ prefix, continuationToken }), `S3 list timed out: ${prefix}`,
      )
      keys.push(...(result.contents ?? result.objects ?? []).map((item: any) => item.key))
      continuationToken = result.isTruncated ? result.nextContinuationToken : undefined
    } while (continuationToken)
    return keys.sort()
  }
  async listPrefixes(prefix: string) {
    const prefixes: string[] = []
    let continuationToken: string | undefined
    do {
      const result = await this.withTimeout<any>(
        this.client.list({ prefix, delimiter: '/', continuationToken }), `S3 prefix list timed out: ${prefix}`,
      )
      prefixes.push(...(result.commonPrefixes ?? []).map((item: any) => item.prefix))
      continuationToken = result.isTruncated ? result.nextContinuationToken : undefined
    } while (continuationToken)
    return [...new Set(prefixes)].sort()
  }
}

function normalizeETag(value: unknown) {
  return typeof value === 'string'
    ? value.trim().replace(/^W\//, '').replace(/^"|"$/g, '')
    : ''
}

export function createSkillRegistryStore(projectRoot = path.resolve(import.meta.dirname, '../..')): SkillRegistryStore {
  const variables = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']
  const configured = variables.filter((name) => process.env[name])
  if (configured.length && configured.length !== variables.length) {
    throw new Error(`Incomplete R2 configuration; required: ${variables.join(', ')}`)
  }
  return configured.length
    ? new BlobSkillRegistryStore(new S3BlobBackend())
    : new LocalSkillRegistryStore(process.env.REGISTRY_DATA_DIR || path.join(projectRoot, '.data/registries'))
}
