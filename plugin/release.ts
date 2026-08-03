import type { SnapshotPackage, SkillRegistrySnapshot } from '#registry/types'
import { sha256 } from '#registry/digest'
import { assertDigest } from '#registry/storage/validation'
import { sameBytes } from '#registry/snapshot'
import { packagePlugin } from './artifact'
import { MAX_PLUGIN_ARTIFACT_COMPRESSED_BYTES } from './bundle'
import { parsePluginManifest, pluginPackageReferenceIdentity } from './manifest'
import { loadCommittedPlugins } from './repository'
import type {
  PluginArtifactDescriptor,
  PluginRelease,
  PluginResolvedPackage,
} from './types'
import {
  MAX_PLUGIN_RELEASE_PACKAGES,
  MAX_PLUGIN_SKILL_ARTIFACTS_ARCHIVE_BYTES,
  MAX_PLUGIN_SKILL_ARTIFACTS_COMPRESSED_BYTES,
  MAX_PLUGIN_SKILL_ARTIFACTS_FILES,
  MAX_PLUGIN_SKILL_ARTIFACTS_UNCOMPRESSED_BYTES,
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
  artifact_bytes: Uint8Array
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
  if (!release || release.schema_version !== '1' || !release.plugin || !Array.isArray(release.packages)) {
    throw new Error(`${label} has an invalid shape`)
  }
  const pluginInput = structuredClone(release.plugin) as PluginRelease['plugin']
  if (pluginInput.author?.email === '') delete (pluginInput.author as { email?: string }).email
  release.plugin = parsePluginManifest(pluginInput, pluginID)
  validatePluginArtifact(release.artifact, label)
  const references = release.plugin.packages ?? []
  if (references.length !== release.packages.length) throw new Error(`${label} does not lock every Package reference`)
  if (release.packages.length > MAX_PLUGIN_RELEASE_PACKAGES) {
    throw new Error(`${label} exceeds the ${MAX_PLUGIN_RELEASE_PACKAGES} Package limit`)
  }
  for (let index = 0; index < references.length; index++) {
    const reference = references[index]!
    const resolved = release.packages[index]!
    if (pluginPackageReferenceIdentity(reference) !== pluginPackageReferenceIdentity(resolved)) {
      throw new Error(`${label} Package lock order does not match plugin.yaml`)
    }
    assertDigest(resolved.revision)
  }
  const canonical = serializePluginRelease(release)
  if (!sameBytes(bytes, canonical)) throw new Error(`${label} must use canonical JSON formatting`)
  return release
}

function validatePackageArtifactBudget(packages: SnapshotPackage[], label: string) {
  let compressed = 0
  let uncompressed = 0
  let archive = 0
  let files = 0
  for (const pkg of packages) {
    for (const skill of pkg.skills) {
      const artifact = skill.artifact
      if (artifact.size > MAX_PLUGIN_SKILL_ARTIFACTS_COMPRESSED_BYTES - compressed
        || artifact.uncompressed_size > MAX_PLUGIN_SKILL_ARTIFACTS_UNCOMPRESSED_BYTES - uncompressed
        || artifact.archive_size > MAX_PLUGIN_SKILL_ARTIFACTS_ARCHIVE_BYTES - archive
        || artifact.file_count > MAX_PLUGIN_SKILL_ARTIFACTS_FILES - files) {
        throw new Error(`${label} Package Skill Artifacts exceed the Plugin install budget`)
      }
      compressed += artifact.size
      uncompressed += artifact.uncompressed_size
      archive += artifact.archive_size
      files += artifact.file_count
    }
  }
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
  const packages = new Map<string, SnapshotPackage>()
  for (const registry of registries) {
    assertDigest(registry.revision)
    for (const pkg of registry.snapshot.packages) {
      const identity = `${registry.snapshot.registry_id}/${pkg.package_id}`
      if (packages.has(identity)) throw new Error(`Duplicate Registry Package identity: ${identity}`)
      packages.set(identity, pkg)
    }
  }

  const candidates: PluginReleaseCandidate[] = []
  const failures: Error[] = []
  for (const plugin of await loadCommittedPlugins(projectRoot)) {
    try {
      const artifact = await packagePlugin(plugin)
      const referencedPackages: SnapshotPackage[] = []
      const resolved = (plugin.manifest.packages ?? []).map((reference): PluginResolvedPackage => {
        const identity = pluginPackageReferenceIdentity(reference)
        const current = packages.get(identity)
        if (!current) throw new Error(`references missing Registry Package: ${identity}`)
        referencedPackages.push(current)
        return { ...reference, revision: current.revision }
      })
      validatePackageArtifactBudget(referencedPackages, plugin.id)
      const release: PluginRelease = {
        schema_version: '1',
        plugin: plugin.manifest,
        artifact: artifact.descriptor,
        packages: resolved,
      }
      const releaseBytes = serializePluginRelease(release)
      candidates.push({
        plugin_id: plugin.id,
        revision: await pluginReleaseRevision(releaseBytes),
        release,
        artifact_bytes: artifact.bytes,
      })
    } catch (error) {
      failures.push(new Error(`${plugin.id}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }))
    }
  }
  if (failures.length) throw new AggregateError(failures, failures.map((error) => error.message).join('\n'))
  return candidates.sort((left, right) => left.plugin_id.localeCompare(right.plugin_id))
}
