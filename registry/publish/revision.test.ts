import { describe, expect, test } from 'bun:test'
import type { CatalogSkill, SkillRegistryDefinition } from '../types'
import { calculateCatalogRevision } from './revision'

const definition: SkillRegistryDefinition = {
  schema_version: '1',
  id: 'example',
  name: 'Example',
  enabled: true,
  priority: 10,
  adapter: { type: 'skill_directory' },
  source: { type: 'local', path: 'skills' },
}

function skill(overrides: Partial<CatalogSkill> = {}): CatalogSkill {
  return {
    schema_version: '1',
    registry_id: 'example',
    registry_priority: 10,
    package_id: 'tools',
    skill_id: 'demo',
    install_id: 'example+tools+demo',
    name: 'Demo',
    description: '',
    author: { name: '', email: '' },
    tags: [],
    category: 'other',
    category_name: 'Other',
    runtime_requirements: { os: [] },
    source: { type: 'local', revision: 'source', path: 'skills/demo' },
    files: ['SKILL.md'],
    artifact: {
      format: 'memoh_skill_v1',
      digest: 'a'.repeat(64),
      size: 1,
      content_type: 'application/gzip',
    },
    ...overrides,
  }
}

function revisionOf(overrides: Partial<SkillRegistryDefinition>, skills: CatalogSkill[] = []) {
  return calculateCatalogRevision({ ...definition, ...overrides }, 'source', skills, [])
}

describe('calculateCatalogRevision', () => {
  test('ignores display-only fields that do not affect what gets built', () => {
    const base = revisionOf({})
    expect(revisionOf({ name: 'Renamed' })).toBe(base)
    expect(revisionOf({ priority: 999 })).toBe(base)
    expect(revisionOf({ enabled: false })).toBe(base)
  })

  test('ignores priority even when Skills carry it as registry_priority', () => {
    const base = revisionOf({}, [skill({ registry_priority: 10 })])
    expect(revisionOf({ priority: 999 }, [skill({ registry_priority: 10 })])).toBe(base)
  })

  test('ignores a Git source tracking_ref change with the same pinned revision', () => {
    const gitSource = { type: 'git', url: 'https://example.test/skills.git', revision: 'a'.repeat(40) } as const
    const base = revisionOf({ source: { ...gitSource, tracking_ref: 'main' } })
    expect(revisionOf({ source: { ...gitSource, tracking_ref: 'develop' } })).toBe(base)
    expect(revisionOf({ source: gitSource })).toBe(base)
  })

  test('changes when a field that affects fetched content changes', () => {
    const base = revisionOf({})
    expect(revisionOf({ id: 'other' })).not.toBe(base)
    expect(revisionOf({ adapter: { type: 'codex_marketplace_skills', catalog_path: 'marketplace.json' } })).not.toBe(base)
    expect(revisionOf({ source: { type: 'local', path: 'other' } })).not.toBe(base)
  })

  test('still changes when a Skill actually differs beyond its registry_priority', () => {
    const base = revisionOf({}, [skill()])
    expect(revisionOf({}, [skill({ description: 'Changed' })])).not.toBe(base)
  })
})
