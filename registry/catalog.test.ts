import { describe, expect, test } from 'bun:test'
import type { CatalogSkill, SkillRegistryCatalog, SkillRegistryDefinition } from './types'
import { normalizeSkillCategory, searchCatalogSkills, summarizeCurrentCatalog, summarizeSkillCategories } from './catalog'

function skill(overrides: Partial<CatalogSkill> = {}): CatalogSkill {
  return {
    schema_version: '1', registry_id: 'openai', registry_priority: 10,
    package_id: 'documents', skill_id: 'pdf', install_id: 'openai--documents--pdf',
    name: 'PDF Tools', description: 'Create and inspect PDF documents.', author: { name: 'OpenAI', email: '' },
    tags: ['documents'], category: 'productivity', category_name: 'Productivity',
    runtime_requirements: { os: ['darwin', 'linux', 'win32'] },
    source: { type: 'git', revision: 'abc', path: 'plugins/documents/skills/pdf', repository: 'https://example.test/repo.git' },
    files: ['SKILL.md'],
    artifact: {
      format: 'memoh_skill_v1', digest: 'a'.repeat(64), size: 100,
      content_type: 'application/gzip',
    },
    ...overrides,
  }
}

describe('Skill Catalog search', () => {
  test('searches, filters and keeps namespaced duplicate IDs', () => {
    const sameID = skill({ registry_id: 'memoh', package_id: 'pdf', install_id: 'memoh--pdf--pdf', registry_priority: 100 })
    const result = searchCatalogSkills([skill(), sameID], { q: 'pdf', os: 'linux' })
    expect(result.total).toBe(2)
    expect(result.data.map((item) => item.registry_id)).toEqual(['memoh', 'openai'])
    expect(searchCatalogSkills([skill()], { tag: 'DOCUMENTS', category: 'productivity' }).total).toBe(1)
    expect(searchCatalogSkills([
      skill({ runtime_requirements: { os: ['linux'] } }),
    ], { os: 'darwin' }).total).toBe(0)
    expect(searchCatalogSkills([
      skill({ runtime_requirements: undefined }),
    ], { os: 'linux' }).total).toBe(0)
  })

  test('sanitizes pagination and sorts by name globally', () => {
    const result = searchCatalogSkills([
      skill({ name: 'Zulu', registry_priority: 100 }),
      skill({ name: 'Alpha', registry_id: 'other', install_id: 'other--documents--pdf', registry_priority: 1 }),
    ], { sort: 'name', page: Number.NaN, limit: Number.POSITIVE_INFINITY })
    expect(result).toMatchObject({ page: 1, limit: 20 })
    expect(result.data.map((item) => item.name)).toEqual(['Alpha', 'Zulu'])
  })

  test('normalizes and summarizes categories', () => {
    expect(normalizeSkillCategory('Developer Tools')).toEqual({
      id: 'developer-tools', name: 'Developer Tools', sourceName: 'Developer Tools',
    })
    expect(normalizeSkillCategory('Data & Analytics')).toEqual({
      id: 'data-analytics', name: 'Data & Analytics', sourceName: 'Data & Analytics',
    })
    expect(summarizeSkillCategories([skill(), skill({ registry_id: 'memoh', install_id: 'memoh--documents--pdf' })]))
      .toEqual([{ id: 'productivity', name: 'Productivity', count: 2, registries: [{ id: 'memoh', count: 1 }, { id: 'openai', count: 1 }] }])
  })

  test('builds a compact current Snapshot summary for Registry listings', () => {
    const registry: SkillRegistryDefinition = {
      schema_version: '1', id: 'openai', name: 'OpenAI', enabled: true, priority: 10,
      adapter: { type: 'skill_directory' }, source: { type: 'local', path: 'skills' },
      refresh_interval_seconds: 43_200, retention: { snapshots: 30 },
    }
    const catalog: SkillRegistryCatalog = {
      schema_version: '1', registry,
      revision: 'a'.repeat(64),
      source_revision: 'source-revision',
      synced_at: '2026-01-01T00:00:00.000Z',
      skills: [skill(), skill({ package_id: 'other', category: 'other', category_name: 'Other' })],
      diagnostics: [{ package_id: 'skipped', code: 'no_skills' as const, message: 'No skills' }],
    }
    expect(summarizeCurrentCatalog(catalog)).toEqual({
      revision: catalog.revision,
      source_revision: 'source-revision',
      synced_at: '2026-01-01T00:00:00.000Z',
      skill_count: 2,
      package_count: 2,
      category_count: 2,
      skipped_package_count: 1,
    })
  })
})
