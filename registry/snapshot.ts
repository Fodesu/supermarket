import { createHash } from 'node:crypto'
import { skillInstallID } from './definition'
import type {
  CatalogSkill,
  SkillRegistrySnapshot,
  SnapshotSkill,
} from './types'

const encoder = new TextEncoder()

export function serializeRegistrySnapshot(snapshot: SkillRegistrySnapshot): Uint8Array {
  return encoder.encode(`${JSON.stringify(snapshot, null, 2)}\n`)
}

export function registrySnapshotRevision(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}

export function compactCatalogSkill(skill: CatalogSkill): SnapshotSkill {
  return {
    package_id: skill.package_id,
    skill_id: skill.skill_id,
    name: skill.name,
    description: skill.description,
    author: skill.author.email ? skill.author : { name: skill.author.name },
    ...(skill.homepage ? { homepage: skill.homepage } : {}),
    tags: skill.tags,
    category: skill.category,
    category_name: skill.category_name,
    ...(skill.source_category ? { source_category: skill.source_category } : {}),
    ...(skill.runtime_requirements?.os.length ? { runtime_requirements: skill.runtime_requirements } : {}),
    source_path: skill.source.path,
    files: skill.files,
    ...(skill.icon ? { icon: skill.icon } : {}),
    artifact: {
      digest: skill.artifact.digest,
      size: skill.artifact.size,
    },
  }
}

export function catalogSkillsFromSnapshot(snapshot: SkillRegistrySnapshot): CatalogSkill[] {
  return snapshot.skills.map((skill) => ({
    schema_version: '1',
    registry_id: snapshot.registry_id,
    registry_priority: snapshot.registry_priority,
    package_id: skill.package_id,
    skill_id: skill.skill_id,
    install_id: skillInstallID(snapshot.registry_id, skill.package_id, skill.skill_id),
    name: skill.name,
    description: skill.description,
    author: { name: skill.author.name, email: skill.author.email ?? '' },
    homepage: skill.homepage,
    tags: skill.tags,
    category: skill.category,
    category_name: skill.category_name,
    source_category: skill.source_category,
    runtime_requirements: skill.runtime_requirements,
    source: {
      type: snapshot.source.type,
      revision: snapshot.source.revision,
      path: skill.source_path,
      repository: snapshot.source.repository,
    },
    files: skill.files,
    icon: skill.icon,
    artifact: {
      format: 'memoh_skill_v1',
      digest: skill.artifact.digest,
      size: skill.artifact.size,
      content_type: 'application/gzip',
    },
  }))
}
