import { describe, expect, test } from 'bun:test'
import type { PluginReleaseCandidate } from '../release'
import type { PluginRelease } from '../types'
import { diffPluginReleaseCandidates, renderPluginReleaseDiffs } from './release-diff'

function candidate(revision: string, registryRevision: string, skillDigest: string): PluginReleaseCandidate {
  const artifact = {
    format: 'memoh_plugin_v1' as const, digest: 'f'.repeat(64), size: 10,
    content_type: 'application/gzip' as const,
  }
  const release: PluginRelease = {
    schema_version: '1',
    plugin: {
      schema_version: '1', id: 'example', name: 'Example', version: '1.0.0',
      description: 'Example', author: { name: 'Memoh', email: '' },
      skills: [{ registry_id: 'memoh', package_id: 'tools', skill_id: 'search' }],
    },
    artifact,
    skills: [{
      registry_id: 'memoh', package_id: 'tools', skill_id: 'search',
      registry_revision: registryRevision, source_revision: 'source',
      install_id: 'memoh+tools+search',
      artifact: {
        format: 'memoh_skill_v1', digest: skillDigest, size: 20,
        content_type: 'application/gzip',
      },
    }],
  }
  return {
    plugin_id: 'example', revision, release, releaseBytes: new Uint8Array(),
    artifact: { descriptor: artifact, bytes: new Uint8Array() },
  }
}

describe('Plugin release review', () => {
  test('shows affected Plugin and pinned Skill revisions without changing its Bundle', () => {
    const diffs = diffPluginReleaseCandidates(
      [candidate('a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64))],
      [candidate('d'.repeat(64), 'e'.repeat(64), 'f'.repeat(64))],
    )
    expect(diffs).toHaveLength(1)
    expect(diffs[0]).toMatchObject({
      plugin: 'example', bundle_before: 'f'.repeat(64), bundle_after: 'f'.repeat(64),
      skills: [{ identity: 'memoh/tools/search', artifact_before: 'c'.repeat(64), artifact_after: 'f'.repeat(64) }],
    })
    const report = renderPluginReleaseDiffs(diffs)
    expect(report).toContain('Affected Plugin releases')
    expect(report).toContain('`memoh/tools/search`')
    expect(report).toContain('approves both the Registry release and these pinned Plugin releases')
  })

  test('omits Plugins whose release revision did not change', () => {
    const current = candidate('a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64))
    expect(diffPluginReleaseCandidates([current], [current])).toEqual([])
    expect(renderPluginReleaseDiffs([])).toBe('')
  })
})
