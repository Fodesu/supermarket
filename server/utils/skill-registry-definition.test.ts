import { describe, expect, test } from 'bun:test'
import { parseSkillRegistryDefinition, resolveSkillRuntimeRequirements, safeRelativePath } from './skill-registry-definition'

describe('Skill Registry definitions', () => {
  test('parses sources and applies skill, package, declared and default OS precedence', () => {
    const definition = parseSkillRegistryDefinition({
      id: 'example', name: 'Example', adapter: 'codex_marketplace_skills',
      source: { type: 'git', url: 'https://example.test/skills.git' }, catalog_path: 'marketplace.json',
      refresh_interval: '12h',
      defaults: { runtime_requirements: { os: ['linux', 'darwin'] } },
      package_overrides: { mac: { runtime_requirements: { os: ['darwin'] } } },
      skill_overrides: { 'mac/cross': { runtime_requirements: { os: ['win32'] } } },
    })
    expect(resolveSkillRuntimeRequirements(definition, 'mac', 'cross')).toEqual({ os: ['win32'] })
    expect(resolveSkillRuntimeRequirements(definition, 'mac', 'other')).toEqual({ os: ['darwin'] })
    expect(resolveSkillRuntimeRequirements(definition, 'other', 'declared', { os: ['linux'] })).toEqual({ os: ['linux'] })
    expect(resolveSkillRuntimeRequirements(definition, 'other', 'default')).toEqual({ os: ['darwin', 'linux'] })
    expect(definition.refresh_interval_seconds).toBe(43_200)
  })

  test('rejects unknown adapters, unsafe paths and malformed overrides', () => {
    expect(() => safeRelativePath('../private')).toThrow('escapes its source')
    expect(() => parseSkillRegistryDefinition({
      id: 'bad', name: 'Bad', adapter: 'plugin_yaml', source: { type: 'local', path: 'skills' },
    })).toThrow('unsupported adapter')
    expect(() => parseSkillRegistryDefinition({
      id: 'bad', name: 'Bad', adapter: 'skill_directory', source: { type: 'local', path: 'skills' },
      refresh_interval: '12h',
      skill_overrides: { malformed: { runtime_requirements: { os: ['linux'] } } },
    })).toThrow('invalid skill override id')
    expect(() => parseSkillRegistryDefinition({
      id: 'bad', name: 'Bad', adapter: 'skill_directory', source: { type: 'local', path: 'skills' },
    })).toThrow('refresh_interval')
  })
})
