import { createHash } from 'node:crypto'
import type {
  SkillArtifactDescriptor,
  SkillArtifactBlob,
  SkillRegistryCatalog,
  SkillRegistryDefinition,
  SkillRegistryStatus,
} from '../types/skill-registry'
import { MAX_SKILL_ARTIFACT_COMPRESSED_BYTES } from '../types/skill-registry'
import { assertRegistryID } from './skill-registry-definition'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export interface BlobBackend {
  get(key: string): Promise<Uint8Array | null>
  put(key: string, value: Uint8Array): Promise<void>
  list(prefix: string): Promise<string[]>
  listPrefixes?(prefix: string): Promise<string[]>
  getStream?(key: string): Promise<{ body: ReadableStream<Uint8Array>; size?: number } | null>
}

export interface SkillRegistryStore {
  listRegistryIDs(): Promise<string[]>
  getDefinition(registryID: string): Promise<SkillRegistryDefinition | null>
  putDefinition(definition: SkillRegistryDefinition): Promise<void>
  getCatalog(registryID: string): Promise<SkillRegistryCatalog | null>
  publishCatalog(catalog: SkillRegistryCatalog): Promise<void>
  getStatus(registryID: string): Promise<SkillRegistryStatus | null>
  putStatus(status: SkillRegistryStatus): Promise<void>
  putArtifact(descriptor: SkillArtifactDescriptor, bytes: Uint8Array): Promise<void>
  getArtifact(digest: string): Promise<{ descriptor: SkillArtifactBlob; bytes: Uint8Array } | null>
  getArtifactStream?(digest: string): Promise<{
    descriptor: SkillArtifactBlob
    body: ReadableStream<Uint8Array> | Uint8Array
  } | null>
}

function assertDigest(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid artifact digest: ${value}`)
  return value
}

function jsonBytes(value: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(value, null, 2)}\n`)
}

function validateArtifactBlob(descriptor: SkillArtifactBlob, digest: string) {
  if (descriptor.format !== 'memoh_skill_v1' || descriptor.content_type !== 'application/gzip'
    || descriptor.digest !== digest || !Number.isSafeInteger(descriptor.size) || descriptor.size < 0
    || descriptor.size > MAX_SKILL_ARTIFACT_COMPRESSED_BYTES) {
    throw new Error(`Invalid stored Artifact metadata: ${digest}`)
  }
}

function verifiedArtifactStream(body: ReadableStream<Uint8Array>, descriptor: SkillArtifactBlob) {
  const hash = createHash('sha256')
  let size = 0
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      size += chunk.length
      if (size > descriptor.size) throw new Error(`Stored Artifact size is corrupt: ${descriptor.digest}`)
      hash.update(chunk)
      controller.enqueue(chunk)
    },
    flush() {
      if (size !== descriptor.size || hash.digest('hex') !== descriptor.digest) {
        throw new Error(`Stored Artifact content is corrupt: ${descriptor.digest}`)
      }
    },
  }))
}

async function readJSON<T>(backend: BlobBackend, key: string): Promise<T | null> {
  const value = await backend.get(key)
  return value ? JSON.parse(decoder.decode(value)) as T : null
}

export async function sha256(value: Uint8Array | string): Promise<string> {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value
  const hash = await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer)
  return [...new Uint8Array(hash)].map((item) => item.toString(16).padStart(2, '0')).join('')
}

export class BlobSkillRegistryStore implements SkillRegistryStore {
  constructor(private readonly backend: BlobBackend) {}

  async listRegistryIDs(): Promise<string[]> {
    if (this.backend.listPrefixes) {
      const prefixes = await this.backend.listPrefixes('skill-registries/')
      return [...new Set(prefixes.flatMap((prefix): string[] => {
        const match = prefix.match(/^skill-registries\/([^/]+)\/$/)
        return match?.[1] ? [match[1]] : []
      }))].sort()
    }
    const keys = await this.backend.list('skill-registries/')
    return [...new Set(keys.flatMap((key): string[] => {
      const match = key.match(/^skill-registries\/([^/]+)\/(?:definition|current|status)\.json$/)
      return match?.[1] ? [match[1]] : []
    }))].sort()
  }

  getDefinition(registryID: string) {
    assertRegistryID(registryID, 'registry ID')
    return readJSON<SkillRegistryDefinition>(this.backend, `skill-registries/${registryID}/definition.json`)
  }

  async putDefinition(definition: SkillRegistryDefinition) {
    const id = assertRegistryID(definition.id, 'registry ID')
    await this.backend.put(`skill-registries/${id}/definition.json`, jsonBytes(definition))
  }

  async getCatalog(registryID: string) {
    assertRegistryID(registryID, 'registry ID')
    const pointer = await readJSON<{ revision: string }>(this.backend, `skill-registries/${registryID}/current.json`)
    return pointer
      ? readJSON<SkillRegistryCatalog>(this.backend, `skill-registries/${registryID}/catalogs/${pointer.revision}.json`)
      : null
  }

  async publishCatalog(catalog: SkillRegistryCatalog) {
    const id = assertRegistryID(catalog.registry.id, 'registry ID')
    const revision = assertDigest(catalog.revision)
    const key = `skill-registries/${id}/catalogs/${revision}.json`
    const bytes = jsonBytes(catalog)
    const existing = await this.backend.get(key)
    let syncedAt = catalog.synced_at
    if (existing) {
      const stored = JSON.parse(decoder.decode(existing)) as SkillRegistryCatalog
      if (stored.revision !== revision || stored.content_revision !== catalog.content_revision || stored.registry.id !== id) {
        throw new Error(`Catalog revision ${revision} is immutable`)
      }
      syncedAt = stored.synced_at
    }
    if (!existing) await this.backend.put(key, bytes)
    await this.backend.put(`skill-registries/${id}/current.json`, jsonBytes({ revision, synced_at: syncedAt }))
  }

  getStatus(registryID: string) {
    assertRegistryID(registryID, 'registry ID')
    return readJSON<SkillRegistryStatus>(this.backend, `skill-registries/${registryID}/status.json`)
  }

  async putStatus(status: SkillRegistryStatus) {
    const id = assertRegistryID(status.registry_id, 'registry ID')
    await this.backend.put(`skill-registries/${id}/status.json`, jsonBytes(status))
  }

  async putArtifact(descriptor: SkillArtifactDescriptor, bytes: Uint8Array) {
    assertRegistryID(descriptor.registry_id, 'registry ID')
    assertRegistryID(descriptor.package_id, 'package ID')
    assertRegistryID(descriptor.skill_id, 'skill ID')
    assertDigest(descriptor.digest)
    if (descriptor.format !== 'memoh_skill_v1') throw new Error(`Unsupported artifact format: ${descriptor.format}`)
    if (descriptor.size > MAX_SKILL_ARTIFACT_COMPRESSED_BYTES) throw new Error('Artifact exceeds compressed size limit')
    if (descriptor.size !== bytes.length) throw new Error('Artifact size does not match its content')
    if (descriptor.digest !== await sha256(bytes)) throw new Error('Artifact digest does not match its content')
    const blob: SkillArtifactBlob = {
      format: descriptor.format,
      digest: descriptor.digest,
      size: descriptor.size,
      content_type: descriptor.content_type,
    }
    const metadataKey = `skill-artifacts/${descriptor.digest}.json`
    const archiveKey = `skill-artifacts/${descriptor.digest}.tar.gz`
    const [storedMetadata, storedArchive] = await Promise.all([
      this.backend.get(metadataKey), this.backend.get(archiveKey),
    ])
    if (storedMetadata && decoder.decode(storedMetadata) !== decoder.decode(jsonBytes(blob))) {
      throw new Error(`Artifact ${descriptor.digest} metadata is immutable`)
    }
    if (storedArchive && await sha256(storedArchive) !== descriptor.digest) {
      throw new Error(`Artifact ${descriptor.digest} content is immutable`)
    }
    if (!storedArchive) await this.backend.put(archiveKey, bytes)
    if (!storedMetadata) await this.backend.put(metadataKey, jsonBytes(blob))
  }

  async getArtifact(digest: string) {
    assertDigest(digest)
    const [descriptor, bytes] = await Promise.all([
      readJSON<SkillArtifactBlob>(this.backend, `skill-artifacts/${digest}.json`),
      this.backend.get(`skill-artifacts/${digest}.tar.gz`),
    ])
    if (!descriptor || !bytes) return null
    validateArtifactBlob(descriptor, digest)
    if (bytes.length !== descriptor.size || await sha256(bytes) !== digest) {
      throw new Error(`Stored Artifact content is corrupt: ${digest}`)
    }
    return { descriptor, bytes }
  }

  async getArtifactStream(digest: string) {
    assertDigest(digest)
    const descriptor = await readJSON<SkillArtifactBlob>(this.backend, `skill-artifacts/${digest}.json`)
    if (!descriptor) return null
    validateArtifactBlob(descriptor, digest)
    if (this.backend.getStream) {
      const streamed = await this.backend.getStream(`skill-artifacts/${digest}.tar.gz`)
      if (!streamed) return null
      if (streamed.size != null && streamed.size !== descriptor.size) {
        throw new Error(`Stored Artifact size is corrupt: ${digest}`)
      }
      return { descriptor, body: verifiedArtifactStream(streamed.body, descriptor) }
    }
    const artifact = await this.getArtifact(digest)
    return artifact ? { descriptor: artifact.descriptor, body: artifact.bytes } : null
  }
}

interface R2ObjectLike {
  arrayBuffer(): Promise<ArrayBuffer>
  body?: ReadableStream<Uint8Array>
  size?: number
}
interface R2BucketLike {
  get(key: string): Promise<R2ObjectLike | null>
  put(key: string, value: Uint8Array): Promise<unknown>
  list(options?: { prefix?: string; cursor?: string; delimiter?: string }): Promise<{
    objects: Array<{ key: string }>
    truncated: boolean
    cursor?: string
    delimitedPrefixes?: string[]
  }>
}

export class R2BlobBackend implements BlobBackend {
  constructor(private readonly bucket: R2BucketLike) {}
  async get(key: string) {
    const object = await this.bucket.get(key)
    return object ? new Uint8Array(await object.arrayBuffer()) : null
  }
  async put(key: string, value: Uint8Array) { await this.bucket.put(key, value) }
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
  async listPrefixes(prefix: string) {
    const prefixes: string[] = []
    let cursor: string | undefined
    do {
      const page = await this.bucket.list({ prefix, cursor, delimiter: '/' })
      prefixes.push(...(page.delimitedPrefixes ?? []))
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
    return [...new Set(prefixes)].sort()
  }
}
