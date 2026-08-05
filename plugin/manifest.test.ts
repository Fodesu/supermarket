import { describe, expect, test } from 'bun:test'
import { parsePluginManifest, pluginPackageReferenceIdentity } from './manifest'
import { MAX_PLUGIN_RELEASE_PACKAGES } from './types'

describe('Plugin manifests', () => {
  test('parses a Package-based Plugin', () => {
    expect(parsePluginManifest({
      schema_version: '1',
      id: 'example',
      name: 'Example',
      version: '1.0.0',
      description: 'Example Plugin',
      author: { name: 'Memoh', email: 'support@example.com' },
      icon: { kind: 'external_url', url: 'https://example.com/icon.svg' },
      packages: [{ registry_id: 'memoh', package_id: 'example' }],
    }, 'example')).toMatchObject({
      id: 'example',
      author: { name: 'Memoh', email: 'support@example.com' },
      packages: [{ registry_id: 'memoh', package_id: 'example' }],
    })
  })

  test('rejects mismatched identities and obsolete MCP fields', () => {
    const base = {
      schema_version: '1',
      id: 'example',
      name: 'Example',
      version: '1.0.0',
      description: 'Example Plugin',
      author: { name: 'Memoh' },
    }
    expect(() => parsePluginManifest(base, 'different')).toThrow('does not match directory')
    expect(() => parsePluginManifest({ ...base, id: 'example.plugin' })).toThrow('Invalid Plugin ID')
    for (const field of ['mcps', 'auth_requirements', 'variables']) {
      expect(() => parsePluginManifest({ ...base, [field]: [] }))
        .toThrow(`unsupported field: ${field}`)
    }
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
