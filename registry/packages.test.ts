import { describe, expect, test } from 'bun:test'
import type { CatalogSkill, SkillRegistrySnapshot } from './types'
import { compactCatalogPackages } from './snapshot'
import { catalogPackagesFromSnapshot, packageDescriptorFromSnapshot, searchSkillPackages } from './packages'

function skill(overrides: Partial<CatalogSkill> = {}): CatalogSkill {
  return {
    schema_version: '1', registry_id: 'openai', registry_priority: 10,
    package_id: 'notion', skill_id: 'search', install_id: 'openai+notion+search',
    name: 'Search Notion', description: 'Search a workspace', author: { name: 'OpenAI', email: '' },
    tags: ['search'], category: 'productivity', category_name: 'Productivity',
    source: { type: 'git', revision: 'a'.repeat(40), path: 'notion/search' },
    files: ['SKILL.md'],
    artifact: {
      format: 'memoh_skill_v1', digest: 'b'.repeat(64), size: 100,
      uncompressed_size: 200, archive_size: 300, file_count: 1,
      content_type: 'application/gzip',
    },
    ...overrides,
  }
}

function snapshot(skills: CatalogSkill[], registryID = 'openai', priority = 10): SkillRegistrySnapshot {
  return {
    schema_version: '1', registry_id: registryID, registry_priority: priority,
    source: { type: 'git', revision: 'a'.repeat(40) },
    packages: compactCatalogPackages(skills),
    diagnostics: [],
  }
}

describe('Skill Packages', () => {
  test('reads stored Packages without merging the same ID across Registries', () => {
    const openai = snapshot([
      skill(),
      skill({ skill_id: 'write', install_id: 'openai+notion+write', name: 'Write Notion', tags: ['write'] }),
    ])
    const memohSkill = skill({ registry_id: 'memoh', install_id: 'memoh+notion+search', registry_priority: 100 })
    const packages = [
      ...catalogPackagesFromSnapshot(openai),
      ...catalogPackagesFromSnapshot(snapshot([memohSkill], 'memoh', 100)),
    ]
    expect(packages).toHaveLength(2)
    expect(packages.find((pkg) => pkg.registry_id === 'openai')).toMatchObject({
      package_id: 'notion', name: 'notion', skill_count: 2,
      tags: ['search', 'write'],
      categories: [{ id: 'productivity', name: 'Productivity', skill_count: 2 }],
    })
    expect(packages.find((pkg) => pkg.registry_id === 'memoh')).toMatchObject({ skill_count: 1 })
  })

  test('searches and filters at Package granularity', () => {
    const packages = catalogPackagesFromSnapshot(snapshot([
      skill(),
      skill({
        package_id: 'figma', skill_id: 'design', install_id: 'openai+figma+design',
        name: 'Design in Figma', description: 'Create interface designs', tags: ['design'],
      }),
    ]))
    expect(searchSkillPackages(packages, { q: 'workspace' }).data.map((pkg) => pkg.package_id)).toEqual(['notion'])
    expect(searchSkillPackages(packages, { tag: 'design' }).data.map((pkg) => pkg.package_id)).toEqual(['figma'])
    expect(searchSkillPackages(packages, { category: 'productivity' }).total).toBe(2)
  })

  test('derives a pinned descriptor from one Snapshot revision', () => {
    const value = snapshot([
      skill(),
      skill({
        skill_id: 'write', install_id: 'openai+notion+write', name: 'Write Notion',
        artifact: { ...skill().artifact, digest: 'c'.repeat(64) },
      }),
    ])
    const descriptor = packageDescriptorFromSnapshot(value, 'd'.repeat(64), 'notion')
    expect(descriptor).toMatchObject({
      registry_id: 'openai', package_id: 'notion', revision: 'd'.repeat(64),
      source_revision: 'a'.repeat(40), skill_count: 2,
    })
    expect(descriptor?.skills.map((item) => [item.skill_id, item.artifact.digest])).toEqual([
      ['search', 'b'.repeat(64)],
      ['write', 'c'.repeat(64)],
    ])
    expect(packageDescriptorFromSnapshot(value, 'd'.repeat(64), 'missing')).toBeUndefined()
  })
})
