import { describe, expect, test } from 'bun:test'
import type { CatalogSkill } from '../types/skill-registry'
import { normalizeSkillCategory, searchCatalogSkills, summarizeSkillCategories } from './skill-catalog-search'

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
      registry_id: 'openai', package_id: 'documents', skill_id: 'pdf', source_revision: 'abc',
      format: 'memoh_skill_v1', digest: 'a'.repeat(64), size: 100, filename: 'openai--documents--pdf.tar.gz',
      content_type: 'application/gzip', created_at: '2026-01-01T00:00:00.000Z',
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
    expect(searchCatalogSkills([skill()], { os: 'android' }).total).toBe(0)
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
    expect(summarizeSkillCategories([skill(), skill({ registry_id: 'memoh', install_id: 'memoh--documents--pdf' })]))
      .toEqual([{ id: 'productivity', name: 'Productivity', count: 2, registries: [{ id: 'memoh', count: 1 }, { id: 'openai', count: 1 }] }])
  })
})
