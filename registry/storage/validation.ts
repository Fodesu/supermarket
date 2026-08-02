import { createHash } from 'node:crypto'
import * as z from 'zod/mini'
import type {
  SkillArtifactBlob,
  SkillImageAsset,
  SkillRegistrySnapshot,
} from '../types'
import {
  MAX_SKILL_ARTIFACT_ARCHIVE_BYTES,
  MAX_SKILL_ARTIFACT_COMPRESSED_BYTES,
  MAX_SKILL_ARTIFACT_FILES,
  MAX_SKILL_ARTIFACT_UNCOMPRESSED_BYTES,
} from '../types'
import { assertRegistryComponentID } from '../definition'
import {
  MAX_REGISTRY_SKILLS,
  MAX_REGISTRY_SOURCE_BYTES,
  MAX_REGISTRY_SOURCE_FILES,
} from '../budget'
import { assertSafeArchivePaths } from '#lib/archive'
import { assertDigest } from '#lib/digest'

export { assertDigest } from '#lib/digest'

const artifactBlobSchema = z.object({
  format: z.literal('memoh_skill_v1'),
  content_type: z.literal('application/gzip'),
  digest: z.string(),
  size: z.number().check(z.int(), z.minimum(1), z.maximum(MAX_SKILL_ARTIFACT_COMPRESSED_BYTES)),
})

const imageAssetSchema = z.object({
  content_type: z.enum(['image/svg+xml', 'image/png', 'image/jpeg', 'image/webp']),
  digest: z.string(),
  size: z.number().check(z.int(), z.minimum(1), z.maximum(512 * 1024)),
})

export function validateArtifactBlob(descriptor: SkillArtifactBlob, digest: string) {
  const result = artifactBlobSchema.safeParse(descriptor)
  if (!result.success || descriptor.digest !== digest) {
    throw new Error(`Invalid stored Artifact metadata: ${digest}`)
  }
}

export function validateImageAsset(descriptor: SkillImageAsset, digest: string) {
  const result = imageAssetSchema.safeParse(descriptor)
  if (!result.success || descriptor.digest !== digest) {
    throw new Error(`Invalid stored Skill image metadata: ${digest}`)
  }
}

export function validateStoredSnapshot(
  snapshot: SkillRegistrySnapshot,
  registryID: string,
  key: string,
) {
  if (!snapshot || snapshot.schema_version !== '1' || snapshot.registry_id !== registryID
    || !Number.isSafeInteger(snapshot.registry_priority)
    || !snapshot.source || (snapshot.source.type !== 'local' && snapshot.source.type !== 'git')
    || typeof snapshot.source.revision !== 'string' || !snapshot.source.revision
    || !Array.isArray(snapshot.skills) || !Array.isArray(snapshot.diagnostics)) {
    throw new Error(`Invalid stored Snapshot: ${key}`)
  }
  if (snapshot.source.type === 'git' && typeof snapshot.source.repository !== 'string') {
    throw new Error(`Invalid stored Snapshot source: ${key}`)
  }
  if (snapshot.skills.length > MAX_REGISTRY_SKILLS) {
    throw new Error(`Stored Snapshot exceeds ${MAX_REGISTRY_SKILLS} Skills: ${key}`)
  }
  let totalSourceBytes = 0
  let totalFiles = 0
  for (const skill of snapshot.skills) {
    if (!skill || !skill.artifact || typeof skill.source_path !== 'string' || !skill.source_path
      || !Array.isArray(skill.files) || !Array.isArray(skill.tags) || !skill.author
      || typeof skill.author.name !== 'string'
      || (skill.author.email !== undefined && typeof skill.author.email !== 'string')) {
      throw new Error(`Invalid stored Snapshot Skill: ${key}`)
    }
    try {
      assertRegistryComponentID(skill.package_id, 'package ID')
      assertRegistryComponentID(skill.skill_id, 'skill ID')
      assertSafeArchivePaths(skill.files, 'Snapshot Skill')
      assertDigest(skill.artifact.digest)
      if (!Number.isSafeInteger(skill.artifact.size) || skill.artifact.size < 1
        || skill.artifact.size > MAX_SKILL_ARTIFACT_COMPRESSED_BYTES) {
        throw new Error('Catalog Skill contains invalid Artifact size')
      }
      if (!Number.isSafeInteger(skill.artifact.uncompressed_size)
        || skill.artifact.uncompressed_size < 1
        || skill.artifact.uncompressed_size > MAX_SKILL_ARTIFACT_UNCOMPRESSED_BYTES) {
        throw new Error('Catalog Skill contains invalid uncompressed Artifact size')
      }
      if (!Number.isSafeInteger(skill.artifact.archive_size)
        || skill.artifact.archive_size < 1
        || skill.artifact.archive_size > MAX_SKILL_ARTIFACT_ARCHIVE_BYTES) {
        throw new Error('Catalog Skill contains invalid archive Artifact size')
      }
      if (!Number.isSafeInteger(skill.artifact.file_count)
        || skill.artifact.file_count < 1
        || skill.artifact.file_count > MAX_SKILL_ARTIFACT_FILES
        || skill.artifact.file_count !== skill.files.length) {
        throw new Error('Catalog Skill contains invalid Artifact file count')
      }
      if (skill.artifact.uncompressed_size > MAX_REGISTRY_SOURCE_BYTES - totalSourceBytes) {
        throw new Error('Catalog Skills exceed the Registry source byte limit')
      }
      if (skill.artifact.file_count > MAX_REGISTRY_SOURCE_FILES - totalFiles) {
        throw new Error('Catalog Skills exceed the Registry source file limit')
      }
      totalSourceBytes += skill.artifact.uncompressed_size
      totalFiles += skill.artifact.file_count
      for (const image of [skill.icon?.card, skill.icon?.detail, skill.icon?.dark]) {
        if (image) {
          assertDigest(image.digest)
          validateImageAsset(image, image.digest)
        }
      }
    } catch {
      throw new Error(`Invalid stored Snapshot Artifact reference: ${key}`)
    }
  }
}

export function verifiedAssetStream(
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
