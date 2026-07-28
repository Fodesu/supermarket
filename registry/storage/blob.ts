import { createHash } from 'node:crypto'
import type {
  SkillArtifactDescriptor,
  SkillArtifactBlob,
  SkillImageAsset,
  SkillRegistryCatalog,
  SkillRegistryState,
} from '../types'
import { MAX_SKILL_ARTIFACT_COMPRESSED_BYTES } from '../types'
import { assertRegistryID } from '../definition'
import { sha256 } from '../digest'
import {
  type BlobBackend,
  type SkillRegistryStore,
} from './contracts'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function assertDigest(value: string): string {
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

export function validateStoredCatalog(
  catalog: SkillRegistryCatalog,
  registryID: string,
  revision: string,
  key: string,
) {
  if (!catalog || catalog.schema_version !== '1' || catalog.registry?.id !== registryID
    || catalog.revision !== revision || !Array.isArray(catalog.skills) || !Array.isArray(catalog.diagnostics)) {
    throw new Error(`Invalid stored Catalog: ${key}`)
  }
  for (const skill of catalog.skills) {
    if (!skill || skill.schema_version !== '1' || skill.registry_id !== registryID || !skill.artifact) {
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

export class BlobSkillRegistryStore implements SkillRegistryStore {
  constructor(protected readonly backend: BlobBackend) {}

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
    if (state.schema_version !== '1' || state.definition?.id !== id || !state.status?.state) {
      throw new Error(`Invalid Registry state: ${id}`)
    }
    if (state.current_snapshot) assertDigest(state.current_snapshot)
    return state
  }

  async putState(state: SkillRegistryState) {
    const id = assertRegistryID(state.definition.id, 'registry ID')
    if (state.schema_version !== '1' || !state.status?.state) throw new Error(`Invalid Registry state: ${id}`)
    if (state.current_snapshot) assertDigest(state.current_snapshot)
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

  async publishSnapshot(catalog: SkillRegistryCatalog, state: SkillRegistryState, assertWriterActive: () => void = () => {}) {
    const id = assertRegistryID(catalog.registry.id, 'registry ID')
    const revision = assertDigest(catalog.revision)
    if (state.definition.id !== id || state.current_snapshot !== revision) {
      throw new Error(`Snapshot state does not match Catalog: ${id}/${revision}`)
    }
    const key = `skill-registries/${id}/snapshots/${revision}.json`
    const bytes = jsonBytes(catalog)
    let existing = await this.backend.get(key)
    if (existing) {
      const stored = JSON.parse(decoder.decode(existing)) as SkillRegistryCatalog
      validateStoredCatalog(stored, id, revision, key)
    }
    if (!existing && this.backend.putConditional) {
      assertWriterActive()
      const version = await this.backend.putConditional(key, bytes, null)
      if (!version) {
        existing = await this.backend.get(key)
        if (!existing) throw new Error(`Snapshot appeared but could not be read: ${revision}`)
        const stored = JSON.parse(decoder.decode(existing)) as SkillRegistryCatalog
        validateStoredCatalog(stored, id, revision, key)
      }
    } else if (!existing) {
      assertWriterActive()
      await this.backend.put(key, bytes)
    }
    assertWriterActive()
    await this.putState(state)
  }

  // Uploads a digest-addressed object. These keys are immutable: a duplicate or
  // late-landing PUT writes identical bytes, so an unknown outcome is safe to
  // settle by reading the key back, and safe to retry while it is still absent.
  // Exhausted retries throw a plain Error on purpose — unlike mutable pointer
  // writes, an in-flight PUT that lands later cannot corrupt anything, so the
  // writer run does not need to remain active after this failure for safety.
  private async putImmutableObject(key: string, bytes: Uint8Array, label: string) {
    const expected = await sha256(bytes)
    let lastError: unknown
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, attempt === 2 ? 500 : 1_500))
      try {
        if (this.backend.putConditional) {
          const created = await this.backend.putConditional(key, bytes, null)
          return Boolean(created)
        } else {
          const stored = await this.backend.get(key)
          if (stored) {
            if (stored.length !== bytes.length || await sha256(stored) !== expected) {
              throw new Error(`${label} is immutable: ${key}`)
            }
            return false
          }
          await this.backend.put(key, bytes)
          return true
        }
      } catch (error) {
        lastError = error
      }
      const stored = await this.backend.get(key).catch(() => null)
      if (stored && stored.length === bytes.length && await sha256(stored) === expected) return true
    }
    throw new Error(`${label} upload did not complete: ${key}`, { cause: lastError })
  }

  async putArtifact(descriptor: SkillArtifactDescriptor, bytes: Uint8Array) {
    assertDigest(descriptor.digest)
    if (descriptor.format !== 'memoh_skill_v1') throw new Error(`Unsupported artifact format: ${descriptor.format}`)
    if (descriptor.size > MAX_SKILL_ARTIFACT_COMPRESSED_BYTES) throw new Error('Artifact exceeds compressed size limit')
    if (descriptor.size !== bytes.length) throw new Error('Artifact size does not match its content')
    if (descriptor.digest !== await sha256(bytes)) throw new Error('Artifact digest does not match its content')
    const archiveKey = `skill-artifacts/${descriptor.digest}.tar.gz`
    return { stored: await this.putImmutableObject(archiveKey, bytes, 'Artifact') }
  }

  async getArtifact(digest: string) {
    assertDigest(digest)
    const bytes = await this.backend.get(`skill-artifacts/${digest}.tar.gz`)
    if (!bytes) return null
    if (await sha256(bytes) !== digest) {
      throw new Error(`Stored Artifact content is corrupt: ${digest}`)
    }
    const descriptor: SkillArtifactBlob = {
      format: 'memoh_skill_v1', digest, size: bytes.length, content_type: 'application/gzip',
    }
    return { descriptor, bytes }
  }

  async getArtifactStream(digest: string) {
    assertDigest(digest)
    if (this.backend.getStream) {
      const streamed = await this.backend.getStream(`skill-artifacts/${digest}.tar.gz`)
      if (!streamed) return null
      if (streamed.size == null) throw new Error(`Stored Artifact size is unavailable: ${digest}`)
      const descriptor: SkillArtifactBlob = {
        format: 'memoh_skill_v1', digest, size: streamed.size, content_type: 'application/gzip',
      }
      validateArtifactBlob(descriptor, digest)
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

}
