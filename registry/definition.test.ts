import { describe, expect, test } from 'bun:test'
import { parseSkillRegistryDefinition, resolveSkillRuntimeRequirements, safeRelativePath } from './definition'

describe('Skill Registry definitions', () => {
  test('parses sources and accepts only structured Skill OS metadata', () => {
    const definition = parseSkillRegistryDefinition({
      schema_version: '1', id: 'example', name: 'Example',
      adapter: { type: 'codex_marketplace_skills', catalog_path: 'marketplace.json' },
      source: { type: 'git', url: 'https://example.test/skills.git' },
      refresh_interval: '12h', retention: { snapshots: 30 },
    })
    expect(resolveSkillRuntimeRequirements(definition, 'other', 'declared', { os: ['linux'] })).toEqual({ os: ['linux'] })
    expect(() => resolveSkillRuntimeRequirements(definition, 'other', 'declared', { os: ['linux'], oses: [] }))
      .toThrow('contains unsupported field oses')
    expect(resolveSkillRuntimeRequirements(definition, 'other', 'unknown')).toBeUndefined()
    expect(definition.refresh_interval_seconds).toBe(43_200)
    expect(definition.retention).toEqual({ snapshots: 30 })
  })

  test('rejects old adapter syntax, unknown adapters and unsafe paths', () => {
    expect(safeRelativePath('./skills/')).toBe('skills')
    expect(() => safeRelativePath('../private')).toThrow('escapes its source')
    expect(() => parseSkillRegistryDefinition({
      schema_version: '1', id: 'bad', name: 'Bad', adapter: { type: 'plugin_yaml' }, source: { type: 'local', path: 'skills' },
      refresh_interval: '12h',
    })).toThrow('unsupported adapter')
    expect(() => parseSkillRegistryDefinition({
      schema_version: '1', id: 'bad', name: 'Bad', adapter: 'skill_directory',
      source: { type: 'local', path: 'skills' }, refresh_interval: '12h',
    })).toThrow('adapter must be an object')
    expect(() => parseSkillRegistryDefinition({
      schema_version: '1', id: 'bad', name: 'Bad',
      adapter: { type: 'codex_marketplace_skills' },
      source: { type: 'local', path: 'skills' }, refresh_interval: '12h',
    })).toThrow('adapter.catalog_path is required')
    for (const field of ['defaults', 'package_overrides', 'skill_overrides', 'taxonomy']) {
      expect(() => parseSkillRegistryDefinition({
        schema_version: '1', id: 'bad', name: 'Bad', adapter: { type: 'skill_directory' },
        source: { type: 'local', path: 'skills' }, refresh_interval: '12h',
        [field]: {},
      })).toThrow(`unsupported Registry field ${field}`)
    }
    expect(() => parseSkillRegistryDefinition({
      schema_version: '1', id: 'bad', name: 'Bad', adapter: { type: 'skill_directory' }, source: { type: 'local' },
      refresh_interval: '12h', retention: { snapshots: 30 },
    })).toThrow('local source.path is required')
    expect(() => parseSkillRegistryDefinition({
      schema_version: '1', id: 'bad', name: 'Bad', adapter: { type: 'skill_directory' },
      source: { type: 'local', path: 'skills', pathh: 'ignored' }, refresh_interval: '12h',
    })).toThrow('local source contains unsupported field pathh')
    expect(() => parseSkillRegistryDefinition({
      schema_version: '1', id: 'bad', name: 'Bad', adapter: { type: 'skill_directory' },
      source: { type: 'git', url: 'https://example.test/skills.git', branch: 'main' }, refresh_interval: '12h',
    })).toThrow('git source contains unsupported field branch')
    expect(() => parseSkillRegistryDefinition({
      schema_version: '1', id: 'bad', name: 'Bad', adapter: { type: 'skill_directory' }, source: { type: 'local', path: 'skills' },
    })).toThrow('refresh_interval')
    expect(parseSkillRegistryDefinition({
      schema_version: '1', id: 'bad', name: 'Bad', adapter: { type: 'skill_directory' },
      source: { type: 'local', path: 'skills' }, refresh_interval: '12h',
    }).retention).toEqual({ snapshots: 30 })
    expect(() => parseSkillRegistryDefinition({
      schema_version: '1', id: 'bad', name: 'Bad', adapter: { type: 'skill_directory' },
      source: { type: 'local', path: 'skills' }, refresh_interval: '12h', retention: { snapshots: 0 },
    })).toThrow('snapshots')
    for (const url of ['ssh://git@example.test/skills.git', 'git@example.test:skills.git', 'http://example.test/skills.git']) {
      expect(() => parseSkillRegistryDefinition({
        schema_version: '1', id: 'bad', name: 'Bad', adapter: { type: 'skill_directory' },
        source: { type: 'git', url }, refresh_interval: '12h',
      })).toThrow('must use HTTPS')
    }
  })
})
