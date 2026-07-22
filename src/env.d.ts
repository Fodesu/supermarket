interface R2ObjectBody {
  arrayBuffer(): Promise<ArrayBuffer>
  body: ReadableStream<Uint8Array>
  size: number
}
interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>
  put(key: string, value: Uint8Array): Promise<unknown>
  list(options?: { prefix?: string; cursor?: string; delimiter?: string }): Promise<{
    objects: Array<{ key: string }>
    truncated: boolean
    cursor?: string
    delimitedPrefixes?: string[]
  }>
}

interface CloudflareEnv {
  SKILL_REGISTRY_BUCKET: R2Bucket
}
