import { createHash } from 'node:crypto'
import type {
  SkillArtifactDescriptor,
  SkillArtifactBlob,
  SkillImageAsset,
  SkillRegistryCatalog,
  SkillRegistryDefinition,
  SkillRegistryStatus,
} from '../types/skill-registry'
import { MAX_SKILL_ARTIFACT_COMPRESSED_BYTES } from '../types/skill-registry'
import { assertRegistryID } from './skill-registry-definition'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export class IndeterminateRemoteMutationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'IndeterminateRemoteMutationError'
  }
}

export interface BlobBackend {
  get(key: string): Promise<Uint8Array | null>
  put(key: string, value: Uint8Array): Promise<void>
  delete(key: string): Promise<void>
  list(prefix: string): Promise<string[]>
  listPrefixes?(prefix: string): Promise<string[]>
  getStream?(key: string): Promise<{ body: ReadableStream<Uint8Array>; size?: number } | null>
  getVersioned?(key: string): Promise<{ value: Uint8Array; version: string } | null>
  putConditional?(key: string, value: Uint8Array, expectedVersion: string | null): Promise<string | null>
}

export interface SkillRegistryWriterLease {
  owner: string
  assertActive(): void
  abandon(): void
  release(): Promise<void>
}

export interface SkillRegistryStore {
  listRegistryIDs(): Promise<string[]>
  getDefinition(registryID: string): Promise<SkillRegistryDefinition | null>
  putDefinition(definition: SkillRegistryDefinition): Promise<void>
  getCatalog(registryID: string): Promise<SkillRegistryCatalog | null>
  publishCatalog(catalog: SkillRegistryCatalog, assertWriterLease?: () => void): Promise<void>
  getStatus(registryID: string): Promise<SkillRegistryStatus | null>
  putStatus(status: SkillRegistryStatus): Promise<void>
  putArtifact(descriptor: SkillArtifactDescriptor, bytes: Uint8Array): Promise<void>
  getArtifact(digest: string): Promise<{ descriptor: SkillArtifactBlob; bytes: Uint8Array } | null>
  getArtifactStream?(digest: string): Promise<{
    descriptor: SkillArtifactBlob
    body: ReadableStream<Uint8Array> | Uint8Array
  } | null>
  putImage(descriptor: SkillImageAsset, bytes: Uint8Array): Promise<void>
  getImage(digest: string): Promise<{ descriptor: SkillImageAsset; bytes: Uint8Array } | null>
  getImageStream?(digest: string): Promise<{
    descriptor: SkillImageAsset
    body: ReadableStream<Uint8Array> | Uint8Array
  } | null>
  acquireWriterLease?(options?: { leaseMs?: number; heartbeatMs?: number; holder?: string }): Promise<SkillRegistryWriterLease>
  breakWriterLease?(owner: string): Promise<void>
  listCatalogRevisions?(registryID: string): Promise<SkillRegistryCatalog[]>
  deleteCatalogRevision?(registryID: string, revision: string): Promise<void>
  listArtifactDigests?(): Promise<string[]>
  deleteArtifact?(digest: string): Promise<void>
  listImageDigests?(): Promise<string[]>
  deleteImage?(digest: string): Promise<void>
}

function assertDigest(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid artifact digest: ${value}`)
  return value
}

function jsonBytes(value: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(value, null, 2)}\n`)
}

function parseLease(value: Uint8Array) {
  const lease = JSON.parse(decoder.decode(value)) as Record<string, unknown>
  const owner = typeof lease.owner === 'string' ? lease.owner : ''
  const expiresAt = typeof lease.expires_at === 'string' ? Date.parse(lease.expires_at) : Number.NaN
  if (!owner || !Number.isFinite(expiresAt)) throw new Error('Stored Registry writer lease is malformed')
  return {
    owner,
    holder: typeof lease.holder === 'string' ? lease.holder : undefined,
    renewedAt: typeof lease.renewed_at === 'string' ? lease.renewed_at : undefined,
    expiresAt,
    released: typeof lease.released_at === 'string',
  }
}

function validateArtifactBlob(descriptor: SkillArtifactBlob, digest: string) {
  if (descriptor.format !== 'memoh_skill_v1' || descriptor.content_type !== 'application/gzip'
    || descriptor.digest !== digest || !Number.isSafeInteger(descriptor.size) || descriptor.size < 0
    || descriptor.size > MAX_SKILL_ARTIFACT_COMPRESSED_BYTES) {
    throw new Error(`Invalid stored Artifact metadata: ${digest}`)
  }
}

function validateImageAsset(descriptor: SkillImageAsset, digest: string) {
  const supported = new Set(['image/svg+xml', 'image/png', 'image/jpeg', 'image/webp'])
  if (!supported.has(descriptor.content_type) || descriptor.digest !== digest
    || !Number.isSafeInteger(descriptor.size) || descriptor.size < 1 || descriptor.size > 512 * 1024) {
    throw new Error(`Invalid stored Skill image metadata: ${digest}`)
  }
}

function validateStoredCatalog(catalog: SkillRegistryCatalog, registryID: string, revision: string, key: string) {
  if (!catalog || catalog.schema_version !== '1' || catalog.registry?.id !== registryID
    || catalog.revision !== revision || !Array.isArray(catalog.skills) || !Array.isArray(catalog.diagnostics)) {
    throw new Error(`Invalid stored Catalog: ${key}`)
  }
  for (const skill of catalog.skills) {
    if (!skill || skill.schema_version !== '1' || skill.registry_id !== registryID
      || !skill.artifact || skill.artifact.registry_id !== registryID
      || skill.artifact.package_id !== skill.package_id || skill.artifact.skill_id !== skill.skill_id) {
      throw new Error(`Invalid stored Catalog Skill: ${key}`)
    }
    try {
      assertRegistryID(skill.package_id, 'package ID')
      assertRegistryID(skill.skill_id, 'skill ID')
      assertDigest(skill.artifact.digest)
      for (const image of [skill.icon?.card, skill.icon?.detail, skill.icon?.dark]) {
        if (image) {
          assertDigest(image.digest)
          validateImageAsset(image, image.digest)
        }
      }
    } catch {
      throw new Error(`Invalid stored Catalog Artifact reference: ${key}`)
    }
  }
}

function verifiedAssetStream(
  body: ReadableStream<Uint8Array>,
  descriptor: { digest: string; size: number },
  label = 'Artifact',
) {
  const hash = createHash('sha256')
  let size = 0
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      size += chunk.length
      if (size > descriptor.size) throw new Error(`Stored ${label} size is corrupt: ${descriptor.digest}`)
      hash.update(chunk)
      controller.enqueue(chunk)
    },
    flush() {
      if (size !== descriptor.size || hash.digest('hex') !== descriptor.digest) {
        throw new Error(`Stored ${label} content is corrupt: ${descriptor.digest}`)
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

  async acquireWriterLease(options: { leaseMs?: number; heartbeatMs?: number; holder?: string } = {}) {
    if (!this.backend.getVersioned || !this.backend.putConditional) {
      throw new Error('Registry Store backend does not support distributed writer leases')
    }
    const leaseMs = options.leaseMs ?? 15 * 60 * 1000
    const heartbeatMs = options.heartbeatMs ?? Math.min(30_000, Math.max(1_000, Math.floor(leaseMs / 3)))
    if (!Number.isFinite(leaseMs) || leaseMs < 10_000) throw new Error('Registry writer lease must be at least 10000ms')
    if (!Number.isFinite(heartbeatMs) || heartbeatMs < 1_000 || heartbeatMs >= leaseMs / 2) {
      throw new Error('Registry writer lease heartbeat must be at least 1000ms and less than half the lease duration')
    }

    const key = 'skill-registry-maintenance/writer-lease.json'
    const backend = this.backend
    const owner = crypto.randomUUID()
    const holder = options.holder?.slice(0, 200)
    const acquiredAt = new Date().toISOString()
    let version: string | undefined
    let expiresAt = 0
    try {
      for (let attempt = 0; attempt < 8 && !version; attempt++) {
        const current = await backend.getVersioned!(key)
        const now = Date.now()
        if (current) {
          const lease = parseLease(current.value)
          if (!lease.released) {
            const detail = [lease.holder, lease.renewedAt].filter(Boolean).join(', ')
            throw new Error(`Registry writer lease is already held by ${lease.owner}${detail ? ` (${detail})` : ''}; confirm the owner has stopped before using registry:unlock`)
          }
        }
        expiresAt = now + leaseMs
        version = await backend.putConditional!(key, jsonBytes({
          owner, holder, acquired_at: acquiredAt, renewed_at: new Date(now).toISOString(),
          expires_at: new Date(expiresAt).toISOString(),
        }), current?.version ?? null) ?? undefined
      }
    } catch (error) {
      if (error instanceof IndeterminateRemoteMutationError) {
        throw new IndeterminateRemoteMutationError(
          `${error.message}; writer lease owner ${owner} may need registry:unlock after the request is confirmed finished`,
          { cause: error },
        )
      }
      throw error
    }
    if (!version) throw new Error('Could not acquire Registry writer lease')

    let released = false
    let lost: Error | undefined
    let renewal = Promise.resolve()
    const renew = async () => {
      if (released || lost) return
      const now = Date.now()
      const nextExpiresAt = now + leaseMs
      const nextVersion = await backend.putConditional!(key, jsonBytes({
        owner, holder, acquired_at: acquiredAt, renewed_at: new Date(now).toISOString(),
        expires_at: new Date(nextExpiresAt).toISOString(),
      }), version!)
      if (!nextVersion) throw new Error('Registry writer lease was lost during renewal')
      version = nextVersion
      expiresAt = nextExpiresAt
    }
    const heartbeat = setInterval(() => {
      renewal = renewal.then(renew).catch((error) => {
        lost = error instanceof IndeterminateRemoteMutationError
          ? new IndeterminateRemoteMutationError(`${error.message}; writer lease owner ${owner}`, { cause: error })
          : error instanceof Error ? error : new Error(String(error))
      })
    }, heartbeatMs)
    heartbeat.unref?.()

    return {
      owner,
      assertActive() {
        if (lost) throw lost
        if (released) throw new Error('Registry writer lease has been released')
        if (Date.now() + heartbeatMs >= expiresAt) throw new Error('Registry writer lease is too close to expiration')
      },
      abandon() {
        if (released) return
        released = true
        clearInterval(heartbeat)
      },
      async release() {
        if (released) return
        released = true
        clearInterval(heartbeat)
        await renewal
        if (lost) throw lost
        const now = new Date().toISOString()
        let releasedVersion: string | null
        try {
          releasedVersion = await backend.putConditional!(key, jsonBytes({
            owner, holder, acquired_at: acquiredAt, renewed_at: now, expires_at: now, released_at: now,
          }), version!)
        } catch (error) {
          if (error instanceof IndeterminateRemoteMutationError) {
            throw new IndeterminateRemoteMutationError(`${error.message}; writer lease owner ${owner}`, { cause: error })
          }
          throw error
        }
        if (!releasedVersion) throw new Error('Registry writer lease was lost before release')
      },
    } satisfies SkillRegistryWriterLease
  }

  async breakWriterLease(owner: string) {
    if (!this.backend.getVersioned || !this.backend.putConditional) {
      throw new Error('Registry Store backend does not support distributed writer leases')
    }
    if (!/^[a-f0-9-]{36}$/.test(owner)) throw new Error('Invalid Registry writer lease owner')
    const key = 'skill-registry-maintenance/writer-lease.json'
    const current = await this.backend.getVersioned(key)
    if (!current) throw new Error('Registry writer lease does not exist')
    const lease = parseLease(current.value)
    if (lease.owner !== owner) throw new Error(`Registry writer lease owner changed to ${lease.owner}`)
    if (lease.released) return
    if (lease.expiresAt > Date.now()) {
      throw new Error(`Registry writer lease ${owner} has not expired; stop the owner and wait until expires_at before unlocking`)
    }
    const now = new Date().toISOString()
    const releasedVersion = await this.backend.putConditional(key, jsonBytes({
      owner, holder: lease.holder, renewed_at: now, expires_at: now, released_at: now,
      manually_released: true,
    }), current.version)
    if (!releasedVersion) throw new Error('Registry writer lease changed while it was being unlocked')
  }

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

  async publishCatalog(catalog: SkillRegistryCatalog, assertWriterLease: () => void = () => {}) {
    const id = assertRegistryID(catalog.registry.id, 'registry ID')
    const revision = assertDigest(catalog.revision)
    const key = `skill-registries/${id}/catalogs/${revision}.json`
    const bytes = jsonBytes(catalog)
    let existing = await this.backend.get(key)
    let syncedAt = catalog.synced_at
    if (existing) {
      const stored = JSON.parse(decoder.decode(existing)) as SkillRegistryCatalog
      validateStoredCatalog(stored, id, revision, key)
      if (stored.revision !== revision || stored.content_revision !== catalog.content_revision || stored.registry.id !== id) {
        throw new Error(`Catalog revision ${revision} is immutable`)
      }
      syncedAt = stored.synced_at
    }
    if (!existing && this.backend.putConditional) {
      assertWriterLease()
      const version = await this.backend.putConditional(key, bytes, null)
      if (!version) {
        existing = await this.backend.get(key)
        if (!existing) throw new Error(`Catalog revision appeared but could not be read: ${revision}`)
        const stored = JSON.parse(decoder.decode(existing)) as SkillRegistryCatalog
        validateStoredCatalog(stored, id, revision, key)
        if (stored.content_revision !== catalog.content_revision) throw new Error(`Catalog revision ${revision} is immutable`)
        syncedAt = stored.synced_at
      }
    } else if (!existing) {
      assertWriterLease()
      await this.backend.put(key, bytes)
    }
    assertWriterLease()
    await this.backend.put(`skill-registries/${id}/current.json`, jsonBytes({ revision, synced_at: syncedAt }))
  }

  async listCatalogRevisions(registryID: string) {
    const id = assertRegistryID(registryID, 'registry ID')
    const prefix = `skill-registries/${id}/catalogs/`
    const keys = await this.backend.list(prefix)
    const unexpected = keys.find((key) => !key.startsWith(prefix) || !/^[a-f0-9]{64}\.json$/.test(key.slice(prefix.length)))
    if (unexpected) throw new Error(`Unexpected object in Catalog namespace: ${unexpected}`)
    return Promise.all(keys.map(async (key) => {
      const revision = key.slice(prefix.length, -'.json'.length)
      const catalog = await readJSON<SkillRegistryCatalog>(this.backend, key)
      validateStoredCatalog(catalog!, id, revision, key)
      return catalog!
    }))
  }

  async deleteCatalogRevision(registryID: string, revision: string) {
    const id = assertRegistryID(registryID, 'registry ID')
    const digest = assertDigest(revision)
    const pointer = await readJSON<{ revision: string }>(this.backend, `skill-registries/${id}/current.json`)
    if (pointer?.revision === digest) throw new Error(`Cannot delete current Catalog revision: ${id}/${digest}`)
    await this.backend.delete(`skill-registries/${id}/catalogs/${digest}.json`)
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

  async listArtifactDigests() {
    const keys = await this.backend.list('skill-artifacts/')
    return [...new Set(keys.flatMap((key): string[] => {
      const match = key.match(/^skill-artifacts\/([a-f0-9]{64})\.(?:json|tar\.gz)$/)
      return match?.[1] ? [match[1]] : []
    }))].sort()
  }

  async deleteArtifact(digest: string) {
    const value = assertDigest(digest)
    await Promise.all([
      this.backend.delete(`skill-artifacts/${value}.json`),
      this.backend.delete(`skill-artifacts/${value}.tar.gz`),
    ])
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
      return { descriptor, body: verifiedAssetStream(streamed.body, descriptor) }
    }
    const artifact = await this.getArtifact(digest)
    return artifact ? { descriptor: artifact.descriptor, body: artifact.bytes } : null
  }

  async putImage(descriptor: SkillImageAsset, bytes: Uint8Array) {
    const digest = assertDigest(descriptor.digest)
    validateImageAsset(descriptor, digest)
    if (bytes.length !== descriptor.size || await sha256(bytes) !== digest) {
      throw new Error('Skill image metadata does not match its content')
    }
    const metadataKey = `skill-images/${digest}.json`
    const imageKey = `skill-images/${digest}`
    const [storedMetadata, storedImage] = await Promise.all([
      this.backend.get(metadataKey), this.backend.get(imageKey),
    ])
    const metadata = jsonBytes(descriptor)
    if (storedMetadata && decoder.decode(storedMetadata) !== decoder.decode(metadata)) {
      throw new Error(`Skill image ${digest} metadata is immutable`)
    }
    if (storedImage && await sha256(storedImage) !== digest) throw new Error(`Skill image ${digest} content is immutable`)
    if (!storedImage) await this.backend.put(imageKey, bytes)
    if (!storedMetadata) await this.backend.put(metadataKey, metadata)
  }

  async getImage(digest: string) {
    assertDigest(digest)
    const [descriptor, bytes] = await Promise.all([
      readJSON<SkillImageAsset>(this.backend, `skill-images/${digest}.json`),
      this.backend.get(`skill-images/${digest}`),
    ])
    if (!descriptor || !bytes) return null
    validateImageAsset(descriptor, digest)
    if (bytes.length !== descriptor.size || await sha256(bytes) !== digest) throw new Error(`Stored Skill image is corrupt: ${digest}`)
    return { descriptor, bytes }
  }

  async getImageStream(digest: string) {
    assertDigest(digest)
    const descriptor = await readJSON<SkillImageAsset>(this.backend, `skill-images/${digest}.json`)
    if (!descriptor) return null
    validateImageAsset(descriptor, digest)
    if (this.backend.getStream) {
      const streamed = await this.backend.getStream(`skill-images/${digest}`)
      if (!streamed) return null
      if (streamed.size != null && streamed.size !== descriptor.size) throw new Error(`Stored Skill image size is corrupt: ${digest}`)
      return { descriptor, body: verifiedAssetStream(streamed.body, descriptor, 'Skill image') }
    }
    const image = await this.getImage(digest)
    return image ? { descriptor: image.descriptor, body: image.bytes } : null
  }

  async listImageDigests() {
    const keys = await this.backend.list('skill-images/')
    return [...new Set(keys.flatMap((key): string[] => {
      const match = key.match(/^skill-images\/([a-f0-9]{64})(?:\.json)?$/)
      return match?.[1] ? [match[1]] : []
    }))].sort()
  }

  async deleteImage(digest: string) {
    const value = assertDigest(digest)
    await Promise.all([
      this.backend.delete(`skill-images/${value}.json`),
      this.backend.delete(`skill-images/${value}`),
    ])
  }
}

interface R2ObjectLike {
  arrayBuffer(): Promise<ArrayBuffer>
  body?: ReadableStream<Uint8Array>
  size?: number
  etag?: string
}
interface R2BucketLike {
  get(key: string): Promise<R2ObjectLike | null>
  put(key: string, value: Uint8Array, options?: {
    onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string }
  }): Promise<{ etag?: string } | null | void>
  delete(key: string): Promise<unknown>
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
  async delete(key: string) { await this.bucket.delete(key) }
  async getVersioned(key: string) {
    const object = await this.bucket.get(key)
    if (!object) return null
    if (!object.etag) throw new Error(`R2 object has no ETag: ${key}`)
    return { value: new Uint8Array(await object.arrayBuffer()), version: object.etag }
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
