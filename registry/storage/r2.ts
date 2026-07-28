import type { BlobBackend } from './contracts'

interface R2ObjectLike {
  arrayBuffer(): Promise<ArrayBuffer>
  body?: ReadableStream<Uint8Array>
  size?: number
}

interface R2BucketLike {
  get(key: string): Promise<R2ObjectLike | null>
  put(key: string, value: Uint8Array, options?: {
    onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string }
  }): Promise<{ etag?: string } | null | void>
  list(options?: { prefix?: string; cursor?: string }): Promise<{
    objects: Array<{ key: string }>
    truncated: boolean
    cursor?: string
  }>
}

export class R2BlobBackend implements BlobBackend {
  constructor(private readonly bucket: R2BucketLike) {}

  async get(key: string) {
    const object = await this.bucket.get(key)
    return object ? new Uint8Array(await object.arrayBuffer()) : null
  }

  async put(key: string, value: Uint8Array) {
    await this.bucket.put(key, value)
  }

  async putConditional(key: string, value: Uint8Array, expectedVersion: string | null) {
    const result = await this.bucket.put(key, value, {
      onlyIf: expectedVersion === null ? { etagDoesNotMatch: '*' } : { etagMatches: expectedVersion },
    })
    if (!result) return null
    if (!result.etag) throw new Error(`Conditional R2 write returned no ETag: ${key}`)
    return result.etag
  }

  async getStream(key: string) {
    const object = await this.bucket.get(key)
    if (!object) return null
    if (object.body) return { body: object.body, size: object.size }
    const bytes = new Uint8Array(await object.arrayBuffer())
    return { body: new Blob([bytes]).stream(), size: bytes.length }
  }

  async list(prefix: string) {
    const keys: string[] = []
    let cursor: string | undefined
    do {
      const page = await this.bucket.list({ prefix, cursor })
      keys.push(...page.objects.map((object) => object.key))
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
    return keys.sort()
  }
}
