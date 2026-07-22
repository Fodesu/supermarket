import path from 'node:path'
import { LocalSkillRegistryStore } from '../../server/utils/local-skill-registry-store'
import { BlobSkillRegistryStore, type BlobBackend, type SkillRegistryStore } from '../../server/utils/skill-registry-store'

export class S3BlobBackend implements BlobBackend {
  private readonly client: any
  constructor(client?: any) {
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
    const file = this.client.file(key)
    if (!await file.exists()) return null
    return new Uint8Array(await file.arrayBuffer())
  }
  async put(key: string, value: Uint8Array) { await this.client.write(key, value) }
  async list(prefix: string) {
    const keys: string[] = []
    let continuationToken: string | undefined
    do {
      const result = await this.client.list({ prefix, continuationToken })
      keys.push(...(result.contents ?? result.objects ?? []).map((item: any) => item.key))
      continuationToken = result.isTruncated ? result.nextContinuationToken : undefined
    } while (continuationToken)
    return keys.sort()
  }
  async listPrefixes(prefix: string) {
    const prefixes: string[] = []
    let continuationToken: string | undefined
    do {
      const result = await this.client.list({ prefix, delimiter: '/', continuationToken })
      prefixes.push(...(result.commonPrefixes ?? []).map((item: any) => item.prefix))
      continuationToken = result.isTruncated ? result.nextContinuationToken : undefined
    } while (continuationToken)
    return [...new Set(prefixes)].sort()
  }
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
