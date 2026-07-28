import { describe, expect, test } from 'bun:test'
import { parseSkillRegistryDefinition, resolveSkillRuntimeRequirements, safeRelativePath } from './definition'

describe('Skill Registry definitions', () => {
  test('parses sources and applies skill, package, declared and default OS precedence', () => {
    const definition = parseSkillRegistryDefinition({
      schema_version: '1', id: 'example', name: 'Example', adapter: 'codex_marketplace_skills',
      source: { type: 'git', url: 'https://example.test/skills.git' }, catalog_path: 'marketplace.json',
      refresh_interval: '12h', retention: { snapshots: 30 },
      taxonomy: { mappings: { Engineering: 'developer-tools' } },
      defaults: { runtime_requirements: { os: ['linux', 'darwin'] } },
      package_overrides: { mac: { runtime_requirements: { os: ['darwin'] } } },
      skill_overrides: { 'mac/cross': { runtime_requirements: { os: ['win32'] } } },
    })
    expect(resolveSkillRuntimeRequirements(definition, 'mac', 'cross')).toEqual({ os: ['win32'] })
    expect(resolveSkillRuntimeRequirements(definition, 'mac', 'other')).toEqual({ os: ['darwin'] })
    expect(resolveSkillRuntimeRequirements(definition, 'other', 'declared', { os: ['linux'] })).toEqual({ os: ['linux'] })
    expect(resolveSkillRuntimeRequirements(definition, 'other', 'default')).toEqual({ os: ['darwin', 'linux'] })
    expect(definition.refresh_interval_seconds).toBe(43_200)
    expect(definition.retention).toEqual({ snapshots: 30 })
    expect(definition.taxonomy).toEqual({ mappings: { Engineering: 'developer-tools' } })
  })

  test('rejects unknown adapters, unsafe paths and malformed overrides', () => {
    expect(safeRelativePath('./skills/')).toBe('skills')
    expect(() => safeRelativePath('../private')).toThrow('escapes its source')
    expect(() => parseSkillRegistryDefinition({
      schema_version: '1', id: 'bad', name: 'Bad', adapter: 'plugin_yaml', source: { type: 'local', path: 'skills' },
      refresh_interval: '12h',
    })).toThrow('unsupported adapter')
    expect(() => parseSkillRegistryDefinition({
      schema_version: '1', id: 'bad', name: 'Bad', adapter: 'skill_directory', source: { type: 'local', path: 'skills' },
      refresh_interval: '12h', retention: { snapshots: 30 },
      skill_overrides: { malformed: { runtime_requirements: { os: ['linux'] } } },
    })).toThrow('invalid skill override id')
    expect(() => parseSkillRegistryDefinition({
      schema_version: '1', id: 'bad', name: 'Bad', adapter: 'skill_directory', source: { type: 'local', path: 'skills' },
      refresh_interval: '12h', retention: { snapshots: 30 }, package_overrides: { mac: { os: ['darwin'] } },
    })).toThrow('must contain only runtime_requirements')
    expect(() => parseSkillRegistryDefinition({
      schema_version: '1', id: 'bad', name: 'Bad', adapter: 'skill_directory', source: { type: 'local' },
      refresh_interval: '12h', retention: { snapshots: 30 },
    })).toThrow('local source.path is required')
    expect(() => parseSkillRegistryDefinition({
      schema_version: '1', id: 'bad', name: 'Bad', adapter: 'skill_directory', source: { type: 'local', path: 'skills' },
    })).toThrow('refresh_interval')
    expect(() => parseSkillRegistryDefinition({
      schema_version: '2', id: 'bad', name: 'Bad', adapter: 'skill_directory',
      source: { type: 'local', path: 'skills' }, refresh_interval: '12h', retention: { snapshots: 30 },
    })).toThrow('unsupported schema_version')
    expect(() => parseSkillRegistryDefinition({
      schema_version: '1', id: 'bad', name: 'Bad', adapter: 'skill_directory',
      source: { type: 'local', path: 'skills' }, refresh_interval: '12h', retention: { snapshots: 30 },
      taxonomy: { mappings: { Engineering: 'Developer Tools' } },
    })).toThrow('invalid taxonomy mapping')
    expect(parseSkillRegistryDefinition({
      schema_version: '1', id: 'bad', name: 'Bad', adapter: 'skill_directory',
      source: { type: 'local', path: 'skills' }, refresh_interval: '12h',
    }).retention).toEqual({ snapshots: 30 })
    expect(() => parseSkillRegistryDefinition({
      schema_version: '1', id: 'bad', name: 'Bad', adapter: 'skill_directory',
      source: { type: 'local', path: 'skills' }, refresh_interval: '12h', retention: { snapshots: 0 },
    })).toThrow('snapshots')
  })
})
