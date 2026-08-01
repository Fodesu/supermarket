import {
  MAX_SKILL_ARTIFACT_ARCHIVE_BYTES,
  MAX_SKILL_ARTIFACT_COMPRESSED_BYTES,
  MAX_SKILL_ARTIFACT_FILES,
  MAX_SKILL_ARTIFACT_UNCOMPRESSED_BYTES,
  type SkillArtifactDescriptor,
  type SkillRegistrySnapshot,
} from '#registry/types'
import { catalogSkillsFromSnapshot } from '#registry/snapshot'
import { sha256 } from '#registry/digest'
import { assertDigest } from '#registry/storage/validation'
import { isSkillRuntimeOS, skillInstallID } from '#registry/definition'
import { sameBytes } from '#registry/snapshot'
import { packagePlugin, type PackagedPlugin } from './artifact'
import { MAX_PLUGIN_ARTIFACT_COMPRESSED_BYTES } from './bundle'
import { parsePluginManifest, pluginSkillReferenceIdentity } from './manifest'
import { loadCommittedPlugins } from './repository'
import type {
  PluginArtifactDescriptor,
  PluginRelease,
  PluginResolvedSkill,
} from './types'
import {
  MAX_PLUGIN_RELEASE_SKILLS,
  MAX_PLUGIN_SKILL_ARTIFACTS_ARCHIVE_BYTES,
  MAX_PLUGIN_SKILL_ARTIFACTS_COMPRESSED_BYTES,
  MAX_PLUGIN_SKILL_ARTIFACTS_FILES,
  MAX_PLUGIN_SKILL_ARTIFACTS_UNCOMPRESSED_BYTES,
} from './types'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const sourceRevisionPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/

export interface ApprovedSkillRegistrySnapshot {
  revision: string
  snapshot: SkillRegistrySnapshot
}

export interface PluginReleaseCandidate {
  plugin_id: string
  revision: string
  release: PluginRelease
  releaseBytes: Uint8Array
  artifact: PackagedPlugin
}

export function serializePluginRelease(release: PluginRelease): Uint8Array {
  return encoder.encode(`${JSON.stringify(release, null, 2)}\n`)
}

export function pluginReleaseRevision(bytes: Uint8Array) {
  return sha256(bytes)
}

function validatePluginArtifact(descriptor: PluginArtifactDescriptor, label: string) {
  assertDigest(descriptor.digest)
  if (descriptor.format !== 'memoh_plugin_v1' || descriptor.content_type !== 'application/gzip'
    || !Number.isSafeInteger(descriptor.size) || descriptor.size < 1
    || descriptor.size > MAX_PLUGIN_ARTIFACT_COMPRESSED_BYTES) {
    throw new Error(`${label} contains an invalid Plugin Artifact`)
  }
}

function validateResolvedSkill(skill: PluginResolvedSkill, label: string) {
  const identity = pluginSkillReferenceIdentity(skill)
  assertDigest(skill.registry_revision)
  if (typeof skill.source_revision !== 'string' || !sourceRevisionPattern.test(skill.source_revision)
    || typeof skill.install_id !== 'string'
    || skill.install_id !== skillInstallID(skill.registry_id, skill.package_id, skill.skill_id)) {
    throw new Error(`${label} contains an invalid Skill lock: ${identity}`)
  }
  if (!skill.artifact || typeof skill.artifact !== 'object') {
    throw new Error(`${label} contains an invalid Skill Artifact: ${identity}`)
  }
  assertDigest(skill.artifact.digest)
  if (skill.artifact.format !== 'memoh_skill_v1' || skill.artifact.content_type !== 'application/gzip'
    || !Number.isSafeInteger(skill.artifact.size) || skill.artifact.size < 1
    || skill.artifact.size > MAX_SKILL_ARTIFACT_COMPRESSED_BYTES
    || !Number.isSafeInteger(skill.artifact.uncompressed_size)
    || skill.artifact.uncompressed_size < 1
    || skill.artifact.uncompressed_size > MAX_SKILL_ARTIFACT_UNCOMPRESSED_BYTES
    || !Number.isSafeInteger(skill.artifact.archive_size)
    || skill.artifact.archive_size < 1
    || skill.artifact.archive_size > MAX_SKILL_ARTIFACT_ARCHIVE_BYTES
    || !Number.isSafeInteger(skill.artifact.file_count)
    || skill.artifact.file_count < 1
    || skill.artifact.file_count > MAX_SKILL_ARTIFACT_FILES) {
    throw new Error(`${label} contains an invalid Skill Artifact: ${identity}`)
  }
  if (skill.runtime_requirements && (
    !Array.isArray(skill.runtime_requirements.os)
    || !skill.runtime_requirements.os.length
    || skill.runtime_requirements.os.some((os) => !isSkillRuntimeOS(os))
  )) throw new Error(`${label} contains invalid Skill runtime requirements: ${identity}`)
  return skill.artifact
}

function sameSkillArtifactDescriptor(
  left: SkillArtifactDescriptor,
  right: SkillArtifactDescriptor,
) {
  return left.format === right.format
    && left.digest === right.digest
    && left.size === right.size
    && left.uncompressed_size === right.uncompressed_size
    && left.archive_size === right.archive_size
    && left.file_count === right.file_count
    && left.content_type === right.content_type
}

export function parsePluginRelease(
  bytes: Uint8Array,
  pluginID: string,
): PluginRelease {
  const label = `${pluginID}: Plugin release`
  let release: PluginRelease
  try {
    release = JSON.parse(decoder.decode(bytes)) as PluginRelease
  } catch {
    throw new Error(`${label} must contain valid JSON`)
  }
  if (!release || release.schema_version !== '1' || !release.plugin || !Array.isArray(release.skills)) {
    throw new Error(`${label} has an invalid shape`)
  }
  const pluginInput = structuredClone(release.plugin) as PluginRelease['plugin']
  if (pluginInput.author?.email === '') delete (pluginInput.author as { email?: string }).email
  release.plugin = parsePluginManifest(pluginInput, pluginID)
  validatePluginArtifact(release.artifact, label)
  const references = release.plugin.skills ?? []
  if (references.length !== release.skills.length) throw new Error(`${label} does not lock every Skill reference`)
  if (release.skills.length > MAX_PLUGIN_RELEASE_SKILLS) {
    throw new Error(`${label} exceeds the ${MAX_PLUGIN_RELEASE_SKILLS} Skill limit`)
  }
  let totalUncompressedSize = 0
  let totalCompressedSize = 0
  let totalArchiveSize = 0
  let totalFileCount = 0
  const artifactsByDigest = new Map<string, SkillArtifactDescriptor>()
  for (let index = 0; index < references.length; index++) {
    const reference = references[index]!
    const resolved = release.skills[index]!
    if (pluginSkillReferenceIdentity(reference) !== pluginSkillReferenceIdentity(resolved)) {
      throw new Error(`${label} Skill lock order does not match plugin.yaml`)
    }
    const artifact = validateResolvedSkill(resolved, label)
    const existingArtifact = artifactsByDigest.get(artifact.digest)
    if (existingArtifact && !sameSkillArtifactDescriptor(existingArtifact, artifact)) {
      throw new Error(`${label} contains inconsistent descriptors for Skill Artifact: ${artifact.digest}`)
    }
    artifactsByDigest.set(artifact.digest, artifact)
    if (artifact.size > MAX_PLUGIN_SKILL_ARTIFACTS_COMPRESSED_BYTES - totalCompressedSize) {
      throw new Error(`${label} Skill Artifacts exceed the ${MAX_PLUGIN_SKILL_ARTIFACTS_COMPRESSED_BYTES} byte compressed limit`)
    }
    if (artifact.uncompressed_size > MAX_PLUGIN_SKILL_ARTIFACTS_UNCOMPRESSED_BYTES - totalUncompressedSize) {
      throw new Error(`${label} Skill Artifacts exceed the ${MAX_PLUGIN_SKILL_ARTIFACTS_UNCOMPRESSED_BYTES} byte uncompressed limit`)
    }
    if (artifact.archive_size > MAX_PLUGIN_SKILL_ARTIFACTS_ARCHIVE_BYTES - totalArchiveSize) {
      throw new Error(`${label} Skill Artifacts exceed the ${MAX_PLUGIN_SKILL_ARTIFACTS_ARCHIVE_BYTES} byte archive limit`)
    }
    if (artifact.file_count > MAX_PLUGIN_SKILL_ARTIFACTS_FILES - totalFileCount) {
      throw new Error(`${label} Skill Artifacts exceed the ${MAX_PLUGIN_SKILL_ARTIFACTS_FILES} file limit`)
    }
    totalCompressedSize += artifact.size
    totalUncompressedSize += artifact.uncompressed_size
    totalArchiveSize += artifact.archive_size
    totalFileCount += artifact.file_count
  }
  const canonical = serializePluginRelease(release)
  if (!sameBytes(bytes, canonical)) throw new Error(`${label} must use canonical JSON formatting`)
  return release
}

export async function assertPluginReleaseRevision(bytes: Uint8Array, expectedRevision: string) {
  if (await pluginReleaseRevision(bytes) !== assertDigest(expectedRevision)) {
    throw new Error(`Plugin release content does not match revision: ${expectedRevision}`)
  }
}

export async function buildPluginReleaseCandidates(
  projectRoot: string,
  registries: ApprovedSkillRegistrySnapshot[],
): Promise<PluginReleaseCandidate[]> {
  const skills = new Map<string, { registryRevision: string; skill: ReturnType<typeof catalogSkillsFromSnapshot>[number] }>()
  for (const registry of registries) {
    assertDigest(registry.revision)
    for (const skill of catalogSkillsFromSnapshot(registry.snapshot)) {
      const identity = `${skill.registry_id}/${skill.package_id}/${skill.skill_id}`
      if (skills.has(identity)) throw new Error(`Duplicate Registry Skill identity: ${identity}`)
      skills.set(identity, { registryRevision: registry.revision, skill })
    }
  }

  const candidates: PluginReleaseCandidate[] = []
  const failures: Error[] = []
  for (const plugin of await loadCommittedPlugins(projectRoot)) {
    try {
      const artifact = await packagePlugin(plugin)
      const resolved = (plugin.manifest.skills ?? []).map((reference): PluginResolvedSkill => {
        const identity = pluginSkillReferenceIdentity(reference)
        const current = skills.get(identity)
        if (!current) throw new Error(`references missing Registry Skill: ${identity}`)
        return {
          ...reference,
          registry_revision: current.registryRevision,
          source_revision: current.skill.source.revision,
          install_id: current.skill.install_id,
          runtime_requirements: current.skill.runtime_requirements,
          artifact: current.skill.artifact,
        }
      })
      const release: PluginRelease = {
        schema_version: '1',
        plugin: plugin.manifest,
        artifact: artifact.descriptor,
        skills: resolved,
      }
      const releaseBytes = serializePluginRelease(release)
      parsePluginRelease(releaseBytes, plugin.id)
      candidates.push({
        plugin_id: plugin.id,
        revision: await pluginReleaseRevision(releaseBytes),
        release,
        releaseBytes,
        artifact,
      })
    } catch (error) {
      failures.push(new Error(`${plugin.id}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }))
    }
  }
  if (failures.length) throw new AggregateError(failures, failures.map((error) => error.message).join('\n'))
  return candidates.sort((left, right) => left.plugin_id.localeCompare(right.plugin_id))
}
