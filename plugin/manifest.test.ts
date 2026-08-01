import { describe, expect, test } from 'bun:test'
import { parsePluginManifest, pluginSkillReferenceIdentity } from './manifest'

describe('Plugin manifests', () => {
  test('parses a complete remote MCP Plugin', () => {
    expect(parsePluginManifest({
      schema_version: '1',
      id: 'example',
      name: 'Example',
      version: '1.0.0',
      description: 'Example Plugin',
      author: { name: 'Memoh', email: 'support@example.com' },
      icon: { kind: 'external_url', url: 'https://example.com/icon.svg' },
      auth_requirements: [{ key: 'oauth', type: 'managed_oauth' }],
      mcps: [{
        key: 'example',
        transport: 'http',
        url: 'https://example.com/mcp',
        auth_ref: 'oauth',
        visibility: 'hidden',
      }],
      skills: [{ registry_id: 'memoh', package_id: 'example', skill_id: 'example-search' }],
    }, 'example')).toMatchObject({
      id: 'example',
      author: { name: 'Memoh', email: 'support@example.com' },
      mcps: [{ key: 'example', transport: 'http', auth_ref: 'oauth' }],
      skills: [{ registry_id: 'memoh', package_id: 'example', skill_id: 'example-search' }],
    })
  })

  test('rejects mismatched identities, unknown auth references and insecure remote URLs', () => {
    const base = {
      schema_version: '1',
      id: 'example',
      name: 'Example',
      version: '1.0.0',
      description: 'Example Plugin',
      author: { name: 'Memoh' },
    }
    expect(() => parsePluginManifest(base, 'different')).toThrow('does not match directory')
    expect(() => parsePluginManifest({
      ...base,
      mcps: [{ key: 'example', transport: 'http', url: 'https://example.com/mcp', auth_ref: 'missing' }],
    })).toThrow('unknown auth requirement')
    expect(() => parsePluginManifest({
      ...base,
      mcps: [{ key: 'example', transport: 'http', url: 'http://example.com/mcp' }],
    })).toThrow('must use HTTPS')
    expect(() => parsePluginManifest({ ...base, id: 'example.plugin' })).toThrow('Invalid Plugin ID')
    expect(() => parsePluginManifest({
      ...base,
      mcps: [{ key: 'example.mcp', transport: 'http', url: 'https://example.com/mcp' }],
    })).toThrow('Invalid MCP key')
  })

  test('requires unique namespaced Registry Skill references', () => {
    const base = {
      schema_version: '1', id: 'example', name: 'Example', version: '1.0.0',
      description: 'Example Plugin', author: { name: 'Memoh' },
    }
    const reference = { registry_id: 'memoh', package_id: 'notion', skill_id: 'search' }
    expect(pluginSkillReferenceIdentity(reference)).toBe('memoh/notion/search')
    expect(() => parsePluginManifest({ ...base, skills: [reference, reference] })).toThrow('duplicate reference')
    expect(() => parsePluginManifest({
      ...base, skills: [{ ...reference, registry_id: '../memoh' }],
    })).toThrow('Invalid Registry ID')
    expect(() => parsePluginManifest({
      ...base, skills: [{ ...reference, registry_id: 'user' }],
    })).toThrow('Invalid Registry ID')
    expect(() => parsePluginManifest({
      ...base, skills: [{ ...reference, skill_id: 'notion.search' }],
    })).toThrow('Invalid Skill ID')
  })
})
