interface R2ObjectBody { arrayBuffer(): Promise<ArrayBuffer> }
interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>
  put(key: string, value: Uint8Array): Promise<unknown>
  list(options?: { prefix?: string; cursor?: string }): Promise<{
    objects: Array<{ key: string }>
    truncated: boolean
    cursor?: string
  }>
}

interface CloudflareEnv {
  SKILL_REGISTRY_BUCKET: R2Bucket
}
