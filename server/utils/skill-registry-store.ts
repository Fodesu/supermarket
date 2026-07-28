import { createHash } from 'node:crypto'
import type {
  SkillArtifactDescriptor,
  SkillArtifactBlob,
  SkillImageAsset,
  SkillRegistryCatalog,
  SkillRegistryState,
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
  getStream?(key: string): Promise<{ body: ReadableStream<Uint8Array>; size?: number } | null>
  getVersioned?(key: string): Promise<{ value: Uint8Array; version: string } | null>
  putConditional?(key: string, value: Uint8Array, expectedVersion: string | null): Promise<string | null>
}

export interface SkillRegistryStore {
  listRegistryIDs(): Promise<string[]>
  getState(registryID: string): Promise<SkillRegistryState | null>
  putState(state: SkillRegistryState): Promise<void>
  getSnapshot(registryID: string, revision: string): Promise<SkillRegistryCatalog | null>
  publishSnapshot(catalog: SkillRegistryCatalog, state: SkillRegistryState, assertWriterLease?: () => void): Promise<void>
  putArtifact(descriptor: SkillArtifactDescriptor, bytes: Uint8Array): Promise<{ stored: boolean }>
  getArtifact(digest: string): Promise<{ descriptor: SkillArtifactBlob; bytes: Uint8Array } | null>
  getArtifactStream?(digest: string): Promise<{
    descriptor: SkillArtifactBlob
    body: ReadableStream<Uint8Array> | Uint8Array
  } | null>
  putImage(descriptor: SkillImageAsset, bytes: Uint8Array): Promise<{ stored: boolean }>
  getImage(digest: string): Promise<{ descriptor: SkillImageAsset; bytes: Uint8Array } | null>
  getImageStream?(digest: string): Promise<{
    descriptor: SkillImageAsset
    body: ReadableStream<Uint8Array> | Uint8Array
  } | null>
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

  async listRegistryIDs(): Promise<string[]> {
    const keys = await this.backend.list('skill-registries/')
    return [...new Set(keys.flatMap((key): string[] => {
      const match = key.match(/^skill-registries\/([^/]+)\/state\.json$/)
      return match?.[1] ? [match[1]] : []
    }))].sort()
  }

  async getState(registryID: string) {
    const id = assertRegistryID(registryID, 'registry ID')
    const state = await readJSON<SkillRegistryState>(this.backend, `skill-registries/${id}/state.json`)
    if (!state) return null
    if (state.schema_version !== '1' || state.definition?.id !== id || state.status?.registry_id !== id) {
      throw new Error(`Invalid Registry state: ${id}`)
    }
    if (state.current_revision) assertDigest(state.current_revision)
    if (state.status.current_revision && state.status.current_revision !== state.current_revision) {
      throw new Error(`Registry state revision mismatch: ${id}`)
    }
    return state
  }

  async putState(state: SkillRegistryState) {
    const id = assertRegistryID(state.definition.id, 'registry ID')
    if (state.schema_version !== '1' || state.status.registry_id !== id) throw new Error(`Invalid Registry state: ${id}`)
    if (state.current_revision) assertDigest(state.current_revision)
    await this.backend.put(`skill-registries/${id}/state.json`, jsonBytes(state))
  }

  async getSnapshot(registryID: string, revision: string) {
    const id = assertRegistryID(registryID, 'registry ID')
    const digest = assertDigest(revision)
    const key = `skill-registries/${id}/snapshots/${digest}.json`
    const catalog = await readJSON<SkillRegistryCatalog>(this.backend, key)
    if (!catalog) return null
    validateStoredCatalog(catalog, id, digest, key)
    return catalog
  }

  async publishSnapshot(catalog: SkillRegistryCatalog, state: SkillRegistryState, assertWriterLease: () => void = () => {}) {
    const id = assertRegistryID(catalog.registry.id, 'registry ID')
    const revision = assertDigest(catalog.revision)
    if (state.definition.id !== id || state.current_revision !== revision || state.status.registry_id !== id) {
      throw new Error(`Snapshot state does not match Catalog: ${id}/${revision}`)
    }
    const key = `skill-registries/${id}/snapshots/${revision}.json`
    const bytes = jsonBytes(catalog)
    let existing = await this.backend.get(key)
    if (existing) {
      const stored = JSON.parse(decoder.decode(existing)) as SkillRegistryCatalog
      validateStoredCatalog(stored, id, revision, key)
      if (stored.revision !== revision || stored.content_revision !== catalog.content_revision || stored.registry.id !== id) {
        throw new Error(`Catalog revision ${revision} is immutable`)
      }
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
      }
    } else if (!existing) {
      assertWriterLease()
      await this.backend.put(key, bytes)
    }
    assertWriterLease()
    await this.putState({ ...state, status: { ...state.status, current_revision: revision } })
  }

  async listCatalogRevisions(registryID: string) {
    const id = assertRegistryID(registryID, 'registry ID')
    const prefix = `skill-registries/${id}/snapshots/`
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
    const state = await this.getState(id)
    if (state?.current_revision === digest) throw new Error(`Cannot delete current Catalog revision: ${id}/${digest}`)
    await this.backend.delete(`skill-registries/${id}/snapshots/${digest}.json`)
  }

  // Uploads a digest-addressed object. These keys are immutable: a duplicate or
  // late-landing PUT writes identical bytes, so an unknown outcome is safe to
  // settle by reading the key back, and safe to retry while it is still absent.
  // Exhausted retries throw a plain Error on purpose — unlike mutable pointer
  // writes, an in-flight PUT that lands later cannot corrupt anything, so the
  // writer lease does not need to survive this failure for safety.
  private async putImmutableObject(key: string, bytes: Uint8Array, label: string) {
    const expected = await sha256(bytes)
    let lastError: unknown
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, attempt === 2 ? 500 : 1_500))
      try {
        if (this.backend.putConditional) {
          const created = await this.backend.putConditional(key, bytes, null)
          if (created) return
        } else {
          await this.backend.put(key, bytes)
          return
        }
      } catch (error) {
        lastError = error
      }
      const stored = await this.backend.get(key).catch(() => null)
      if (stored && stored.length === bytes.length && await sha256(stored) === expected) return
    }
    throw new Error(`${label} upload did not complete: ${key}`, { cause: lastError })
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
    const metadata = jsonBytes(blob)
    const storedMetadata = await this.backend.get(metadataKey)
    if (storedMetadata) {
      if (decoder.decode(storedMetadata) !== decoder.decode(metadata)) {
        throw new Error(`Artifact ${descriptor.digest} metadata is immutable`)
      }
      // Metadata is only written after its archive, both keys embed the digest,
      // and every read path re-verifies content hashes — so a matching metadata
      // object proves the archive is already stored. Skipping the archive read
      // keeps steady-state refreshes from re-downloading every Artifact.
      return { stored: false }
    }
    const storedArchive = await this.backend.get(archiveKey)
    if (storedArchive) {
      if (await sha256(storedArchive) !== descriptor.digest) {
        throw new Error(`Artifact ${descriptor.digest} content is immutable`)
      }
    } else {
      await this.putImmutableObject(archiveKey, bytes, 'Artifact')
    }
    await this.putImmutableObject(metadataKey, metadata, 'Artifact metadata')
    return { stored: !storedArchive }
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
    // Refresh uses metadata as the committed marker for the archive. Remove
    // that marker first so an interrupted GC can only leave an unreferenced
    // archive behind, never metadata that points to a missing archive.
    await this.backend.delete(`skill-artifacts/${value}.json`)
    await this.backend.delete(`skill-artifacts/${value}.tar.gz`)
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
    const metadata = jsonBytes(descriptor)
    const storedMetadata = await this.backend.get(metadataKey)
    if (storedMetadata) {
      if (decoder.decode(storedMetadata) !== decoder.decode(metadata)) {
        throw new Error(`Skill image ${digest} metadata is immutable`)
      }
      // Same ordering invariant as putArtifact: metadata follows the image.
      return { stored: false }
    }
    const storedImage = await this.backend.get(imageKey)
    if (storedImage) {
      if (await sha256(storedImage) !== digest) throw new Error(`Skill image ${digest} content is immutable`)
    } else {
      await this.putImmutableObject(imageKey, bytes, 'Skill image')
    }
    await this.putImmutableObject(metadataKey, metadata, 'Skill image metadata')
    return { stored: !storedImage }
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
    await this.backend.delete(`skill-images/${value}.json`)
    await this.backend.delete(`skill-images/${value}`)
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
}
