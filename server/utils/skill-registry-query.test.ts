import { describe, expect, test } from 'bun:test'
import { parseSkillRegistryQuery, requireSkillRegistryID } from './skill-registry-query'

describe('Skill Registry query parsing', () => {
  test('normalizes valid filters and pagination', () => {
    expect(parseSkillRegistryQuery({
      registry: 'openai-api-curated', package: 'documents', category: 'Developer-Tools',
      os: 'LINUX', page: '2', limit: '50', sort: 'name',
    })).toEqual({
      registry: 'openai-api-curated', q: undefined, package: 'documents', category: 'developer-tools',
      tag: undefined, os: 'linux', page: 2, limit: 50, sort: 'name',
    })
  })

  test('rejects malformed IDs, repeated values, unsupported options and pagination', () => {
    expect(() => parseSkillRegistryQuery({ registry: 'BAD' })).toThrow('Invalid registry ID')
    expect(() => parseSkillRegistryQuery({ tag: ['one', 'two'] })).toThrow('specified once')
    expect(() => parseSkillRegistryQuery({ os: 'android' })).toThrow('Unsupported os')
    expect(() => parseSkillRegistryQuery({ sort: 'recent' })).toThrow('Unsupported sort')
    expect(() => parseSkillRegistryQuery({ sort: '' })).toThrow('Unsupported sort')
    expect(() => parseSkillRegistryQuery({ page: 'abc' })).toThrow('positive integer')
    expect(() => parseSkillRegistryQuery({ limit: '101' })).toThrow('out of range')
    expect(() => requireSkillRegistryID('../escape', 'registry ID')).toThrow('Invalid registry ID')
  })
})
