import { describe, expect, test } from 'bun:test'
import { parsePluginManifest, pluginPackageReferenceIdentity } from './manifest'
import { MAX_PLUGIN_RELEASE_PACKAGES } from './types'

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
      packages: [{ registry_id: 'memoh', package_id: 'example' }],
    }, 'example')).toMatchObject({
      id: 'example',
      author: { name: 'Memoh', email: 'support@example.com' },
      mcps: [{ key: 'example', transport: 'http', auth_ref: 'oauth' }],
      packages: [{ registry_id: 'memoh', package_id: 'example' }],
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

  test('requires unique namespaced Registry Package references', () => {
    const base = {
      schema_version: '1', id: 'example', name: 'Example', version: '1.0.0',
      description: 'Example Plugin', author: { name: 'Memoh' },
    }
    const reference = { registry_id: 'memoh', package_id: 'notion' }
    expect(pluginPackageReferenceIdentity(reference)).toBe('memoh/notion')
    expect(() => parsePluginManifest({ ...base, packages: [reference, reference] })).toThrow('duplicate reference')
    expect(() => parsePluginManifest({
      ...base, packages: [{ ...reference, registry_id: '../memoh' }],
    })).toThrow('Invalid Registry ID')
    expect(() => parsePluginManifest({
      ...base, packages: [{ ...reference, registry_id: 'user' }],
    })).toThrow('Invalid Registry ID')
    expect(() => parsePluginManifest({
      ...base, packages: [{ ...reference, package_id: 'notion..search' }],
    })).toThrow('Invalid package ID')
    expect(() => parsePluginManifest({
      ...base,
      packages: Array.from({ length: MAX_PLUGIN_RELEASE_PACKAGES + 1 }, (_, index) => ({
        ...reference,
        package_id: `package-${index}`,
      })),
    })).toThrow(`${MAX_PLUGIN_RELEASE_PACKAGES} Package limit`)
  })
})
