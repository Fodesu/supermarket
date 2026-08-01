import { MAX_SKILL_ARTIFACT_COMPRESSED_BYTES, type SkillRegistrySnapshot } from '#registry/types'
import { catalogSkillsFromSnapshot } from '#registry/snapshot'
import { sha256 } from '#registry/digest'
import { assertDigest } from '#registry/storage/validation'
import { isSkillRuntimeOS } from '#registry/definition'
import { sameBytes } from '#registry/snapshot'
import { packagePlugin, type PackagedPlugin } from './artifact'
import { parsePluginManifest, pluginSkillReferenceIdentity } from './manifest'
import { loadCommittedPlugins } from './repository'
import type {
  PluginArtifactDescriptor,
  PluginRelease,
  PluginResolvedSkill,
} from './types'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

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
    || !Number.isSafeInteger(descriptor.size) || descriptor.size < 1) {
    throw new Error(`${label} contains an invalid Plugin Artifact`)
  }
}

function validateResolvedSkill(skill: PluginResolvedSkill, label: string) {
  const identity = pluginSkillReferenceIdentity(skill)
  assertDigest(skill.registry_revision)
  if (!skill.source_revision || !skill.install_id) throw new Error(`${label} contains an invalid Skill lock: ${identity}`)
  assertDigest(skill.artifact.digest)
  if (skill.artifact.format !== 'memoh_skill_v1' || skill.artifact.content_type !== 'application/gzip'
    || !Number.isSafeInteger(skill.artifact.size) || skill.artifact.size < 1
    || skill.artifact.size > MAX_SKILL_ARTIFACT_COMPRESSED_BYTES) {
    throw new Error(`${label} contains an invalid Skill Artifact: ${identity}`)
  }
  if (skill.runtime_requirements && (
    !Array.isArray(skill.runtime_requirements.os)
    || !skill.runtime_requirements.os.length
    || skill.runtime_requirements.os.some((os) => !isSkillRuntimeOS(os))
  )) throw new Error(`${label} contains invalid Skill runtime requirements: ${identity}`)
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
  for (let index = 0; index < references.length; index++) {
    const reference = references[index]!
    const resolved = release.skills[index]!
    if (pluginSkillReferenceIdentity(reference) !== pluginSkillReferenceIdentity(resolved)) {
      throw new Error(`${label} Skill lock order does not match plugin.yaml`)
    }
    validateResolvedSkill(resolved, label)
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
