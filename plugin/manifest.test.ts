import { describe, expect, test } from 'bun:test'
import { parseBundledSkillDocument, parsePluginManifest } from './manifest'

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
    }, 'example')).toMatchObject({
      id: 'example',
      author: { name: 'Memoh', email: 'support@example.com' },
      mcps: [{ key: 'example', transport: 'http', auth_ref: 'oauth' }],
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
  })

  test('requires structured Skill frontmatter', () => {
    expect(parseBundledSkillDocument('example/demo', [
      '---',
      'name: Demo',
      'description: Demo Skill',
      'metadata:',
      '  tags: [demo]',
      '---',
      '# Demo',
    ].join('\n'))).toMatchObject({
      id: 'example/demo',
      name: 'Demo',
      metadata: { tags: ['demo'] },
    })
    expect(() => parseBundledSkillDocument('example/demo', '# Demo')).toThrow('frontmatter')
  })
})
