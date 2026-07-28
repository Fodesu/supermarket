import { createHash } from 'node:crypto'
import type {
  SkillArtifactBlob,
  SkillImageAsset,
  SkillRegistryCatalog,
} from '../types'
import { MAX_SKILL_ARTIFACT_COMPRESSED_BYTES } from '../types'
import { assertRegistryID, isSkillRuntimeOS, skillInstallID } from '../definition'

export function assertDigest(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid artifact digest: ${value}`)
  return value
}

export function validateArtifactBlob(descriptor: SkillArtifactBlob, digest: string) {
  if (descriptor.format !== 'memoh_skill_v1' || descriptor.content_type !== 'application/gzip'
    || descriptor.digest !== digest || !Number.isSafeInteger(descriptor.size) || descriptor.size < 0
    || descriptor.size > MAX_SKILL_ARTIFACT_COMPRESSED_BYTES) {
    throw new Error(`Invalid stored Artifact metadata: ${digest}`)
  }
}

export function validateImageAsset(descriptor: SkillImageAsset, digest: string) {
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
      if (skill.install_id !== skillInstallID(registryID, skill.package_id, skill.skill_id)) {
        throw new Error('Catalog Skill install identity does not match its coordinates')
      }
      if (skill.runtime_requirements && (
        !Array.isArray(skill.runtime_requirements.os)
        || skill.runtime_requirements.os.length === 0
        || skill.runtime_requirements.os.some((os) => !isSkillRuntimeOS(os))
      )) {
        throw new Error('Catalog Skill contains invalid runtime requirements')
      }
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
