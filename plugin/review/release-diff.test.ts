import { describe, expect, test } from 'bun:test'
import type { PluginReleaseCandidate } from '../release'
import type { PluginRelease } from '../types'
import { diffPluginReleaseCandidates, renderPluginReleaseDiffs } from './release-diff'

function candidate(revision: string, packageRevision: string): PluginReleaseCandidate {
  const artifact = {
    format: 'memoh_plugin_v1' as const, digest: 'f'.repeat(64), size: 10,
    content_type: 'application/gzip' as const,
  }
  const release: PluginRelease = {
    schema_version: '1',
    plugin: {
      schema_version: '1', id: 'example', name: 'Example', version: '1.0.0',
      description: 'Example', author: { name: 'Memoh', email: '' },
      packages: [{ registry_id: 'memoh', package_id: 'tools' }],
    },
    artifact,
    packages: [{ registry_id: 'memoh', package_id: 'tools', revision: packageRevision }],
  }
  return { plugin_id: 'example', revision, release, artifact_bytes: new Uint8Array() }
}

describe('Plugin release review', () => {
  test('shows affected Plugin and pinned Package revisions without changing its Bundle', () => {
    const diffs = diffPluginReleaseCandidates(
      [candidate('a'.repeat(64), 'b'.repeat(64))],
      [candidate('d'.repeat(64), 'e'.repeat(64))],
    )
    expect(diffs).toHaveLength(1)
    expect(diffs[0]).toMatchObject({
      plugin: 'example', bundle_before: 'f'.repeat(64), bundle_after: 'f'.repeat(64),
      packages: [{
        identity: 'memoh/tools', revision_before: 'b'.repeat(64), revision_after: 'e'.repeat(64),
      }],
    })
    const report = renderPluginReleaseDiffs(diffs)
    expect(report).toContain('Affected Plugin releases')
    expect(report).toContain('`memoh/tools`')
    expect(report).toContain('approves both the Registry release and these pinned Plugin releases')
  })

  test('omits Plugins whose release revision did not change', () => {
    const current = candidate('a'.repeat(64), 'b'.repeat(64))
    expect(diffPluginReleaseCandidates([current], [current])).toEqual([])
    expect(renderPluginReleaseDiffs([])).toBe('')
  })

  test('truncates a large report at a complete Package boundary', () => {
    const diff = diffPluginReleaseCandidates(
      [candidate('a'.repeat(64), 'b'.repeat(64))],
      [candidate('d'.repeat(64), 'e'.repeat(64))],
    )[0]!
    const report = renderPluginReleaseDiffs([
      { ...diff, packages: Array.from({ length: 100 }, (_, index) => ({
        ...diff.packages[0]!, identity: `memoh/tools-${index}`,
      })) },
    ], 2_000)

    expect(report.length).toBeLessThanOrEqual(2_000)
    expect(report).toContain('truncated at a complete Package boundary')
    expect(report).not.toContain('approves both the Registry release')
  })
})
