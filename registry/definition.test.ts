import { describe, expect, test } from 'bun:test'
import { parseSkillRegistryDefinition, resolveSkillRuntimeRequirements, safeRelativePath } from './definition'

describe('Skill Registry definitions', () => {
  test('parses sources and accepts only structured Skill OS metadata', () => {
    const definition = parseSkillRegistryDefinition({
      schema_version: '1', id: 'example', name: 'Example',
      adapter: { type: 'codex_marketplace_skills', catalog_path: 'marketplace.json' },
      source: {
        type: 'git',
        url: 'https://example.test/skills.git',
        revision: 'a'.repeat(40),
        tracking_ref: 'main',
      },
    })
    expect(resolveSkillRuntimeRequirements(definition, 'other', 'declared', { os: ['linux'] })).toEqual({ os: ['linux'] })
    expect(() => resolveSkillRuntimeRequirements(definition, 'other', 'declared', { os: ['linux'], oses: [] }))
      .toThrow('contains unsupported field oses')
    expect(resolveSkillRuntimeRequirements(definition, 'other', 'unknown')).toBeUndefined()
    expect(definition.source).toMatchObject({ revision: 'a'.repeat(40), tracking_ref: 'main' })
  })

  test('rejects old adapter syntax, unknown adapters and unsafe paths', () => {
    expect(safeRelativePath('./skills/')).toBe('skills')
    expect(() => safeRelativePath('../private')).toThrow('escapes its source')
    expect(() => parseSkillRegistryDefinition({
      schema_version: '1', id: 'bad', name: 'Bad', adapter: { type: 'plugin_yaml' }, source: { type: 'local', path: 'skills' },
    })).toThrow('unsupported adapter')
    expect(() => parseSkillRegistryDefinition({
      schema_version: '1', id: 'bad', name: 'Bad', adapter: 'skill_directory',
      source: { type: 'local', path: 'skills' },
    })).toThrow('adapter must be an object')
    expect(() => parseSkillRegistryDefinition({
      schema_version: '1', id: 'bad', name: 'Bad',
      adapter: { type: 'codex_marketplace_skills' },
      source: { type: 'local', path: 'skills' },
    })).toThrow('adapter.catalog_path is required')
    for (const field of ['defaults', 'package_overrides', 'skill_overrides', 'taxonomy']) {
      expect(() => parseSkillRegistryDefinition({
        schema_version: '1', id: 'bad', name: 'Bad', adapter: { type: 'skill_directory' },
        source: { type: 'local', path: 'skills' },
        [field]: {},
      })).toThrow(`unsupported Registry field ${field}`)
    }
    expect(() => parseSkillRegistryDefinition({
      schema_version: '1', id: 'bad', name: 'Bad', adapter: { type: 'skill_directory' }, source: { type: 'local' },
    })).toThrow('local source.path is required')
    expect(() => parseSkillRegistryDefinition({
      schema_version: '1', id: 'bad', name: 'Bad', adapter: { type: 'skill_directory' },
      source: { type: 'local', path: 'skills', pathh: 'ignored' },
    })).toThrow('local source contains unsupported field pathh')
    expect(() => parseSkillRegistryDefinition({
      schema_version: '1', id: 'bad', name: 'Bad', adapter: { type: 'skill_directory' },
      source: {
        type: 'git',
        url: 'https://example.test/skills.git',
        revision: 'a'.repeat(40),
        branch: 'main',
      },
    })).toThrow('git source contains unsupported field branch')
    expect(() => parseSkillRegistryDefinition({
      schema_version: '1', id: 'bad', name: 'Bad', adapter: { type: 'skill_directory' },
      source: { type: 'git', url: 'https://example.test/skills.git', revision: 'main' },
    })).toThrow('full commit hash')
    for (const url of ['ssh://git@example.test/skills.git', 'git@example.test:skills.git', 'http://example.test/skills.git']) {
      expect(() => parseSkillRegistryDefinition({
        schema_version: '1', id: 'bad', name: 'Bad', adapter: { type: 'skill_directory' },
        source: { type: 'git', url, revision: 'a'.repeat(40) },
      })).toThrow('must use HTTPS')
    }
  })
})
