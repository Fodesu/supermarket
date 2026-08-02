import { createHash } from 'node:crypto'
import { skillInstallID } from './definition'
import type {
  CatalogSkill,
  SnapshotPackage,
  SkillRegistrySnapshot,
  SnapshotSkill,
} from './types'
import { compareCanonicalText } from '#lib/order'

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
    skill_id: skill.skill_id,
    name: skill.name,
    description: skill.description,
    author: skill.author.email ? skill.author : { name: skill.author.name },
    ...(skill.homepage ? { homepage: skill.homepage } : {}),
    tags: skill.tags,
    category: skill.category,
    category_name: skill.category_name,
    ...(skill.source_category ? { source_category: skill.source_category } : {}),
    source_path: skill.source.path,
    files: skill.files,
    ...(skill.icon ? { icon: skill.icon } : {}),
    artifact: {
      digest: skill.artifact.digest,
      size: skill.artifact.size,
      uncompressed_size: skill.artifact.uncompressed_size,
      archive_size: skill.artifact.archive_size,
      file_count: skill.artifact.file_count,
    },
  }
}

export function compactCatalogPackages(skills: CatalogSkill[]): SnapshotPackage[] {
  const groups = new Map<string, CatalogSkill[]>()
  for (const skill of skills) {
    const group = groups.get(skill.package_id) ?? []
    group.push(skill)
    groups.set(skill.package_id, group)
  }
  return [...groups.entries()].sort(([left], [right]) => compareCanonicalText(left, right))
    .map(([packageID, packageSkills]) => {
      const ordered = [...packageSkills].sort((a, b) => compareCanonicalText(a.skill_id, b.skill_id))
      const representative = ordered.find((skill) => skill.skill_id === packageID) ?? ordered[0]!
      return {
        package_id: packageID,
        name: packageID,
        description: representative.description,
        tags: [...new Set(ordered.flatMap((skill) => skill.tags))].sort(compareCanonicalText),
        ...(representative.icon ? { icon: representative.icon } : {}),
        skills: ordered.map(compactCatalogSkill),
      }
    })
}

export function catalogSkillsFromSnapshot(snapshot: SkillRegistrySnapshot): CatalogSkill[] {
  return snapshot.packages.flatMap((pkg) => catalogSkillsFromSnapshotPackage(snapshot, pkg))
}

export function catalogSkillsFromSnapshotPackage(
  snapshot: SkillRegistrySnapshot,
  pkg: SnapshotPackage,
): CatalogSkill[] {
  return pkg.skills.map((skill) => ({
    schema_version: '1',
    registry_id: snapshot.registry_id,
    registry_priority: snapshot.registry_priority,
    package_id: pkg.package_id,
    skill_id: skill.skill_id,
    install_id: skillInstallID(snapshot.registry_id, pkg.package_id, skill.skill_id),
    name: skill.name,
    description: skill.description,
    author: { name: skill.author.name, email: skill.author.email ?? '' },
    homepage: skill.homepage,
    tags: skill.tags,
    category: skill.category,
    category_name: skill.category_name,
    source_category: skill.source_category,
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
      uncompressed_size: skill.artifact.uncompressed_size,
      archive_size: skill.artifact.archive_size,
      file_count: skill.artifact.file_count,
      content_type: 'application/gzip',
    },
  }))
}
