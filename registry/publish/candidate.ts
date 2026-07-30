import type {
  CatalogSkill,
  RegistryDiagnostic,
  SkillArtifactDescriptor,
  SkillImageAsset,
  SkillRegistryDefinition,
  SkillRegistrySnapshot,
} from '../types'
import { buildSkillCandidates, skillAdapterBootstrapPaths } from '../adapters/index'
import { packageSkill } from '../artifacts/build'
import { sha256 } from '../digest'
import { materializeSkillRegistrySource } from '../sources/index'
import {
  compactCatalogSkill,
  registrySnapshotRevision,
  serializeRegistrySnapshot,
} from '../snapshot'
import { compareCanonicalText } from '#lib/order'

const maxReviewTextBytes = 128 * 1024

export interface CandidateFile {
  digest: string
  size: number
  mode: number
  text?: string
}

export interface CandidateSkillReview {
  package_id: string
  skill_id: string
  files: Record<string, CandidateFile>
}

export interface CandidateArtifact {
  descriptor: SkillArtifactDescriptor
  bytes: Uint8Array
}

export interface CandidateImage {
  descriptor: SkillImageAsset
  bytes: Uint8Array
}

export interface SkillRegistryCandidate {
  definition: SkillRegistryDefinition
  source_revision: string
  revision: string
  snapshot: SkillRegistrySnapshot
  snapshotBytes: Uint8Array
  skills: CatalogSkill[]
  diagnostics: RegistryDiagnostic[]
  artifacts: Map<string, CandidateArtifact>
  images: Map<string, CandidateImage>
  review: Map<string, CandidateSkillReview>
}

export type SkillRegistryBuildProgress =
  | { type: 'source'; registry: string }
  | { type: 'source_ready'; registry: string; revision: string }
  | { type: 'scanned'; registry: string; skills: number; diagnostics: number }

function reviewText(name: string, bytes: Uint8Array) {
  if (name !== 'SKILL.md' || bytes.length > maxReviewTextBytes) return undefined
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

export async function buildSkillRegistryCandidate(
  definition: SkillRegistryDefinition,
  projectRoot: string,
  onProgress: (progress: SkillRegistryBuildProgress) => void = () => {},
): Promise<SkillRegistryCandidate> {
  onProgress({ type: 'source', registry: definition.id })
  const source = await materializeSkillRegistrySource(
    definition,
    projectRoot,
    skillAdapterBootstrapPaths(definition),
  )
  try {
    onProgress({ type: 'source_ready', registry: definition.id, revision: source.revision })
    const result = await buildSkillCandidates({
      definition: source.definition,
      sourceRoot: source.root,
      ensurePaths: source.ensurePaths,
    })
    onProgress({
      type: 'scanned',
      registry: definition.id,
      skills: result.skills.length,
      diagnostics: result.diagnostics.length,
    })

    const skills: CatalogSkill[] = []
    const artifacts = new Map<string, CandidateArtifact>()
    const images = new Map<string, CandidateImage>()
    const review = new Map<string, CandidateSkillReview>()
    for (const candidate of result.skills) {
      const packaged = await packageSkill(candidate.files)
      const descriptor: SkillArtifactDescriptor = {
        format: 'memoh_skill_v1',
        digest: packaged.digest,
        size: packaged.bytes.length,
        content_type: 'application/gzip',
      }
      artifacts.set(descriptor.digest, { descriptor, bytes: packaged.bytes })
      for (const image of candidate.icon_assets ?? []) {
        images.set(image.descriptor.digest, image)
      }
      const sourcePath = [definition.source.path, candidate.source_path].filter(Boolean).join('/')
      const skill: CatalogSkill = {
        schema_version: '1',
        registry_id: definition.id,
        registry_priority: definition.priority,
        package_id: candidate.package_id,
        skill_id: candidate.skill_id,
        install_id: candidate.install_id,
        name: candidate.name,
        description: candidate.description,
        author: candidate.author,
        homepage: candidate.homepage,
        tags: candidate.tags,
        category: candidate.category,
        category_name: candidate.category_name,
        source_category: candidate.source_category,
        runtime_requirements: candidate.runtime_requirements,
        source: {
          type: definition.source.type,
          revision: source.revision,
          path: sourcePath,
          repository: definition.source.type === 'git' ? definition.source.url : undefined,
        },
        files: Object.keys(candidate.files).sort(),
        icon: candidate.icon,
        artifact: descriptor,
      }
      skills.push(skill)
      const files = Object.fromEntries(await Promise.all(Object.entries(candidate.files)
        .sort(([left], [right]) => compareCanonicalText(left, right))
        .map(async ([name, file]) => [name, {
          digest: await sha256(file.bytes),
          size: file.bytes.length,
          mode: file.mode,
          text: reviewText(name, file.bytes),
        }])))
      review.set(`${candidate.package_id}/${candidate.skill_id}`, {
        package_id: candidate.package_id,
        skill_id: candidate.skill_id,
        files,
      })
    }

    skills.sort((a, b) => compareCanonicalText(a.name, b.name)
      || compareCanonicalText(a.package_id, b.package_id)
      || compareCanonicalText(a.skill_id, b.skill_id))
    if (!skills.length) {
      throw new Error(`${definition.id}: Registry build produced zero skills`)
    }
    const diagnostics = [...result.diagnostics]
    diagnostics.sort((a, b) => compareCanonicalText(a.package_id ?? '', b.package_id ?? '')
      || compareCanonicalText(a.code, b.code))
    const snapshot: SkillRegistrySnapshot = {
      schema_version: '1',
      registry_id: definition.id,
      registry_priority: definition.priority,
      source: {
        type: definition.source.type,
        revision: source.revision,
        ...(definition.source.type === 'git' ? { repository: definition.source.url } : {}),
      },
      skills: skills.map(compactCatalogSkill),
      diagnostics,
    }
    const snapshotBytes = serializeRegistrySnapshot(snapshot)
    return {
      definition: source.definition,
      source_revision: source.revision,
      revision: registrySnapshotRevision(snapshotBytes),
      snapshot,
      snapshotBytes,
      skills,
      diagnostics,
      artifacts,
      images,
      review,
    }
  } finally {
    await source.cleanup()
  }
}
