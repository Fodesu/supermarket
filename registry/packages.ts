import type {
  CatalogSkill,
  SkillPackageDescriptor,
  SkillPackageSummary,
  SkillRegistrySnapshot,
} from './types'
import { catalogSkillsFromSnapshot } from './snapshot'

export interface SkillPackageSearchOptions {
  q?: string
  registry?: string
  category?: string
  tag?: string
  page?: number
  limit?: number
  sort?: 'relevance' | 'name' | 'registry'
}

function packageSummary(skills: CatalogSkill[]): SkillPackageSummary {
  const ordered = [...skills].sort((a, b) => a.skill_id.localeCompare(b.skill_id))
  const first = ordered[0]!
  const representative = ordered.find((skill) => skill.skill_id === first.package_id) ?? first
  const categories = new Map<string, { name: string; skill_count: number }>()
  const tags = new Set<string>()
  for (const skill of ordered) {
    const category = categories.get(skill.category) ?? { name: skill.category_name, skill_count: 0 }
    category.skill_count++
    categories.set(skill.category, category)
    for (const tag of skill.tags) tags.add(tag)
  }
  return {
    schema_version: '1',
    registry_id: first.registry_id,
    registry_priority: first.registry_priority,
    package_id: first.package_id,
    name: first.package_id,
    description: representative.description,
    tags: [...tags].sort((a, b) => a.localeCompare(b)),
    categories: [...categories.entries()].map(([id, value]) => ({ id, ...value }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    skill_count: ordered.length,
    ...(representative.icon ? { icon: representative.icon } : {}),
  }
}

export function packagesFromSkills(skills: CatalogSkill[]): SkillPackageSummary[] {
  const groups = new Map<string, CatalogSkill[]>()
  for (const skill of skills) {
    const key = `${skill.registry_id}\0${skill.package_id}`
    const group = groups.get(key) ?? []
    group.push(skill)
    groups.set(key, group)
  }
  return [...groups.values()].map(packageSummary)
}

function searchScore(pkg: SkillPackageSummary, skills: CatalogSkill[], rawQuery: string) {
  const query = rawQuery.toLowerCase().trim()
  if (!query) return 0
  if (pkg.package_id.toLowerCase() === query || pkg.name.toLowerCase() === query) return 1000
  if (pkg.package_id.toLowerCase().startsWith(query) || pkg.name.toLowerCase().startsWith(query)) return 800
  if (pkg.tags.some((tag) => tag.toLowerCase() === query)
    || pkg.categories.some((category) => category.id === query || category.name.toLowerCase() === query)) return 700
  if (pkg.tags.some((tag) => tag.toLowerCase().includes(query))
    || pkg.categories.some((category) => category.name.toLowerCase().includes(query))) return 600
  if (pkg.description.toLowerCase().includes(query)
    || skills.some((skill) => skill.name.toLowerCase().includes(query)
      || skill.skill_id.toLowerCase().includes(query)
      || skill.description.toLowerCase().includes(query))) return 400
  return -1
}

export function searchSkillPackages(allSkills: CatalogSkill[], options: SkillPackageSearchOptions = {}) {
  const packages = packagesFromSkills(allSkills).filter((pkg) => {
    if (options.registry && pkg.registry_id !== options.registry) return false
    if (options.category && !pkg.categories.some((category) => category.id === options.category)) return false
    if (options.tag && !pkg.tags.some((tag) => tag.toLowerCase() === options.tag!.toLowerCase())) return false
    return true
  }).map((pkg) => ({
    pkg,
    score: options.q
      ? searchScore(pkg, allSkills.filter((skill) => skill.registry_id === pkg.registry_id && skill.package_id === pkg.package_id), options.q)
      : 0,
  })).filter(({ score }) => score >= 0)

  const sort = options.sort ?? 'relevance'
  packages.sort((a, b) => {
    if (sort === 'relevance' && a.score !== b.score) return b.score - a.score
    if (sort === 'registry') {
      const result = a.pkg.registry_id.localeCompare(b.pkg.registry_id)
      if (result) return result
    }
    if (sort === 'name') {
      const result = a.pkg.name.localeCompare(b.pkg.name)
      if (result) return result
    }
    if (a.pkg.registry_priority !== b.pkg.registry_priority) return b.pkg.registry_priority - a.pkg.registry_priority
    return a.pkg.name.localeCompare(b.pkg.name) || a.pkg.registry_id.localeCompare(b.pkg.registry_id)
  })

  const page = Number.isFinite(options.page) ? Math.max(1, Math.trunc(options.page!)) : 1
  const limit = Number.isFinite(options.limit) ? Math.min(100, Math.max(1, Math.trunc(options.limit!))) : 20
  const start = (page - 1) * limit
  return { total: packages.length, page, limit, data: packages.slice(start, start + limit).map(({ pkg }) => pkg) }
}

export function packageDescriptorFromSnapshot(
  snapshot: SkillRegistrySnapshot,
  revision: string,
  packageID: string,
): SkillPackageDescriptor | undefined {
  const skills = catalogSkillsFromSnapshot(snapshot)
    .filter((skill) => skill.package_id === packageID)
    .sort((a, b) => a.skill_id.localeCompare(b.skill_id))
  if (!skills.length) return undefined
  const { registry_priority: _priority, ...summary } = packageSummary(skills)
  return {
    ...summary,
    revision,
    source_revision: snapshot.source.revision,
    skills,
  }
}
