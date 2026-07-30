import type {
  SkillArtifactBlob,
  SkillArtifactDescriptor,
  SkillImageAsset,
  SkillRegistrySnapshot,
  SkillRegistryState,
} from '../types'
import * as z from 'zod/mini'
import { MAX_SKILL_ARTIFACT_COMPRESSED_BYTES } from '../types'
import { assertRegistryID } from '../definition'
import { summarizeCurrentSnapshot } from '../catalog'
import { sha256 } from '../digest'
import { registrySnapshotRevision, sameBytes, serializeRegistrySnapshot } from '../snapshot'
import {
  type BlobBackend,
  type SkillRegistryStore,
} from './contracts'
import {
  assertDigest,
  validateArtifactBlob,
  validateImageAsset,
  validateStoredSnapshot,
  verifiedAssetStream,
} from './validation'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
export const MAX_REGISTRY_STATE_BYTES = 256 * 1024
export const MAX_REGISTRY_SNAPSHOT_BYTES = 8 * 1024 * 1024

const summaryCountsSchema = z.object({
  skill_count: z.number().check(z.int(), z.minimum(0)),
  package_count: z.number().check(z.int(), z.minimum(0)),
  category_count: z.number().check(z.int(), z.minimum(0)),
  skipped_package_count: z.number().check(z.int(), z.minimum(0)),
})

function validateState(state: SkillRegistryState, id: string) {
  if (state.schema_version !== '1' || state.definition?.id !== id) {
    throw new Error(`Invalid Registry state: ${id}`)
  }
  if (!state.current_snapshot) {
    if (state.current_summary) throw new Error(`Registry state has a summary without a Snapshot: ${id}`)
    return
  }
  assertDigest(state.current_snapshot)
  const summary = state.current_summary
  if (!summary || summary.revision !== state.current_snapshot
    || !summary.source_revision || !Number.isFinite(Date.parse(summary.published_at))) {
    throw new Error(`Registry state has an invalid current summary: ${id}`)
  }
  if (!summaryCountsSchema.safeParse(summary).success) {
    throw new Error(`Registry state has invalid summary counts: ${id}`)
  }
}

function jsonBytes(value: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(value, null, 2)}\n`)
}

async function readJSON<T>(backend: BlobBackend, key: string, maxBytes: number): Promise<T | null> {
  const value = await backend.get(key)
  if (!value) return null
  if (value.length > maxBytes) throw new Error(`Stored JSON object exceeds ${maxBytes} bytes: ${key}`)
  return JSON.parse(decoder.decode(value)) as T
}

export class BlobSkillRegistryStore implements SkillRegistryStore {
  constructor(protected readonly backend: BlobBackend) {}

  async listRegistryIDs(): Promise<string[]> {
    const prefixes = await this.backend.listPrefixes('skill-registries/')
    return [...new Set(prefixes.flatMap((prefix): string[] => {
      const match = prefix.match(/^skill-registries\/([^/]+)\/$/)
      return match?.[1] ? [match[1]] : []
    }))].sort()
  }

  async getState(registryID: string) {
    return (await this.getStateWithVersion(registryID)).state
  }

  // Paired with putState's expectedVersion: callers that need to detect a
  // concurrent publish read the version here first, then pass it back to
  // putState so a stale write is rejected instead of silently clobbering.
  async getStateWithVersion(registryID: string) {
    const id = assertRegistryID(registryID, 'registry ID')
    const key = `skill-registries/${id}/state.json`
    if (this.backend.getWithVersion) {
      const result = await this.backend.getWithVersion(key)
      if (!result) return { state: null, version: null }
      if (result.value.length > MAX_REGISTRY_STATE_BYTES) {
        throw new Error(`Stored JSON object exceeds ${MAX_REGISTRY_STATE_BYTES} bytes: ${key}`)
      }
      const state = JSON.parse(decoder.decode(result.value)) as SkillRegistryState
      validateState(state, id)
      return { state, version: result.version }
    }
    const state = await readJSON<SkillRegistryState>(this.backend, key, MAX_REGISTRY_STATE_BYTES)
    if (state) validateState(state, id)
    return { state, version: null }
  }

  async putState(state: SkillRegistryState, expectedVersion?: string | null) {
    const id = assertRegistryID(state.definition.id, 'registry ID')
    validateState(state, id)
    const bytes = jsonBytes(state)
    if (bytes.length > MAX_REGISTRY_STATE_BYTES) throw new Error(`Registry state exceeds ${MAX_REGISTRY_STATE_BYTES} bytes: ${id}`)
    const key = `skill-registries/${id}/state.json`
    if (expectedVersion !== undefined && this.backend.putConditional) {
      const version = await this.backend.putConditional(key, bytes, expectedVersion)
      if (!version) throw new Error(`Registry state changed concurrently, refusing to overwrite: ${id}`)
      return
    }
    await this.backend.put(key, bytes)
  }

  async getSnapshot(registryID: string, revision: string) {
    const id = assertRegistryID(registryID, 'registry ID')
    const digest = assertDigest(revision)
    const key = `skill-registries/${id}/snapshots/${digest}.json`
    const bytes = await this.backend.get(key)
    if (!bytes) return null
    if (bytes.length > MAX_REGISTRY_SNAPSHOT_BYTES) {
      throw new Error(`Stored JSON object exceeds ${MAX_REGISTRY_SNAPSHOT_BYTES} bytes: ${key}`)
    }
    if (registrySnapshotRevision(bytes) !== digest) {
      throw new Error(`Stored Snapshot content does not match its revision: ${key}`)
    }
    const snapshot = JSON.parse(decoder.decode(bytes)) as SkillRegistrySnapshot
    validateStoredSnapshot(snapshot, id, key)
    if (!sameBytes(bytes, serializeRegistrySnapshot(snapshot))) {
      throw new Error(`Stored Snapshot is not canonically serialized: ${key}`)
    }
    return snapshot
  }

  async publishSnapshot(
    bytes: Uint8Array,
    definition: SkillRegistryState['definition'],
    options: { expectedVersion?: string | null; publishedAt?: string } = {},
  ) {
    const id = assertRegistryID(definition.id, 'registry ID')
    if (bytes.length > MAX_REGISTRY_SNAPSHOT_BYTES) {
      throw new Error(`Registry snapshot exceeds ${MAX_REGISTRY_SNAPSHOT_BYTES} bytes: ${id}`)
    }
    const snapshot = JSON.parse(decoder.decode(bytes)) as SkillRegistrySnapshot
    validateStoredSnapshot(snapshot, id, `registries/${id}/snapshot.json`)
    if (!sameBytes(bytes, serializeRegistrySnapshot(snapshot))) {
      throw new Error(`Registry Snapshot is not canonically serialized: ${id}`)
    }
    const revision = assertDigest(registrySnapshotRevision(bytes))
    const key = `skill-registries/${id}/snapshots/${revision}.json`
    await this.putImmutableObject(key, bytes, 'Snapshot')
    const publishedAt = options.publishedAt ?? new Date().toISOString()
    if (!Number.isFinite(Date.parse(publishedAt))) throw new Error(`Invalid Snapshot publication time: ${publishedAt}`)
    await this.putState({
      schema_version: '1',
      definition,
      current_snapshot: revision,
      current_summary: summarizeCurrentSnapshot(snapshot, revision, publishedAt),
    }, options.expectedVersion)
    return revision
  }

  // Uploads a digest-addressed object. These keys are immutable: a duplicate or
  // late-landing PUT writes identical bytes, so an unknown outcome is safe to
  // settle by reading the key back, and safe to retry while it is still absent.
  // Exhausted retries throw a plain Error on purpose — unlike mutable pointer
  // writes, an in-flight PUT that lands later cannot corrupt anything, so the
  // publication does not need special recovery after this failure for safety.
  private async putImmutableObject(key: string, bytes: Uint8Array, label: string) {
    const expected = await sha256(bytes)
    let lastError: unknown
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, attempt === 2 ? 500 : 1_500))
      try {
        if (this.backend.putConditional) {
          const created = await this.backend.putConditional(key, bytes, null)
          if (created) return true
          const stored = await this.backend.get(key)
          if (!stored) throw new Error(`${label} appeared but could not be read: ${key}`)
          if (stored.length !== bytes.length || await sha256(stored) !== expected) {
            throw new Error(`${label} is immutable: ${key}`)
          }
          return false
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
        if (error instanceof Error && error.message === `${label} is immutable: ${key}`) throw error
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
      const storedImage = await this.backend.get(imageKey)
      if (!storedImage) {
        await this.putImmutableObject(imageKey, bytes, 'Skill image')
        return { stored: true }
      }
      if (storedImage.length !== bytes.length || await sha256(storedImage) !== digest) {
        throw new Error(`Skill image is immutable: ${imageKey}`)
      }
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
      readJSON<SkillImageAsset>(this.backend, `skill-images/${digest}.json`, MAX_REGISTRY_STATE_BYTES),
      this.backend.get(`skill-images/${digest}`),
    ])
    if (!descriptor || !bytes) return null
    validateImageAsset(descriptor, digest)
    if (bytes.length !== descriptor.size || await sha256(bytes) !== digest) throw new Error(`Stored Skill image is corrupt: ${digest}`)
    return { descriptor, bytes }
  }

  async getImageStream(digest: string) {
    assertDigest(digest)
    const descriptor = await readJSON<SkillImageAsset>(
      this.backend,
      `skill-images/${digest}.json`,
      MAX_REGISTRY_STATE_BYTES,
    )
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
