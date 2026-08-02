import { describe, expect, test } from 'bun:test'
import {
  parseSkillRegistryQuery,
  requireIdentifier,
  requireRegistryComponentID,
  requireRegistryID,
} from './skill-registry-query'

describe('Skill Registry query parsing', () => {
  test('normalizes valid filters and pagination', () => {
    expect(parseSkillRegistryQuery({
      registry: 'openai', package: 'documents', category: 'Developer-Tools',
      page: '2', limit: '50', sort: 'name',
    })).toEqual({
      registry: 'openai', q: undefined, package: 'documents', category: 'developer-tools',
      tag: undefined, page: 2, limit: 50, sort: 'name',
    })
  })

  test('rejects malformed IDs, repeated values, unsupported options and pagination', () => {
    expect(() => parseSkillRegistryQuery({ registry: 'BAD' })).toThrow('Invalid registry ID')
    expect(() => parseSkillRegistryQuery({ tag: ['one', 'two'] })).toThrow('specified once')
    expect(() => parseSkillRegistryQuery({ sort: 'recent' })).toThrow('Unsupported sort')
    expect(() => parseSkillRegistryQuery({ sort: '' })).toThrow('Unsupported sort')
    expect(() => parseSkillRegistryQuery({ page: 'abc' })).toThrow('positive integer')
    expect(() => parseSkillRegistryQuery({ limit: '101' })).toThrow('out of range')
    expect(() => requireIdentifier('../escape', 'plugin ID')).toThrow('Invalid plugin ID')
    expect(requireRegistryComponentID('documents.v2', 'package ID')).toBe('documents.v2')
    expect(() => requireRegistryComponentID('documents..v2', 'package ID')).toThrow('Invalid package ID')
    expect(() => requireRegistryID('user')).toThrow('Invalid registry ID')
  })
})
