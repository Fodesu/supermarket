import { describe, expect, test } from 'bun:test'
import type { PluginReleaseDiff } from '#plugin/review/release-diff'
import type { RegistryReleaseDiff } from '#registry/review/release-diff'
import {
  MAX_REGISTRY_UPDATE_REPORT_LENGTH,
  renderFullRegistryUpdateReport,
  renderRegistryUpdateReport,
} from './check-updates'

describe('Registry update report', () => {
  test('keeps the combined Registry and Plugin report within the PR body budget', () => {
    const registryDiff: RegistryReleaseDiff = {
      registry: 'example',
      source_before: '1'.repeat(40),
      source_after: '2'.repeat(40),
      snapshot_before: 'a'.repeat(64),
      snapshot_after: 'b'.repeat(64),
      skipped_packages: [],
      packages: [{
        package_id: 'tools',
        status: 'changed',
        skills: Array.from({ length: 100 }, (_, index) => ({
          skill_id: `skill-${index}`,
          status: 'changed',
          metadata: [],
          files: [],
          text_patches: [{ path: 'SKILL.md', patch: `-${'a'.repeat(1_000)}\n+${'b'.repeat(1_000)}` }],
        })),
      }],
      summary: {
        packages_skipped: 0,
        packages_changed: 1,
        skills_added: 0,
        skills_removed: 0,
        skills_changed: 100,
      },
    }
    const pluginDiffs: PluginReleaseDiff[] = Array.from({ length: 100 }, (_, index) => ({
      plugin: `plugin-${index}`,
      release_before: 'd'.repeat(64),
      release_after: 'e'.repeat(64),
      bundle_before: 'f'.repeat(64),
      bundle_after: '0'.repeat(64),
      packages: Array.from({ length: 10 }, (_, packageIndex) => ({
        identity: `example/tools-${packageIndex}`,
        revision_before: '1'.repeat(64),
        revision_after: '2'.repeat(64),
      })),
    }))

    const fullReportURL = 'https://github.example/actions/runs/123#artifacts'
    const report = renderRegistryUpdateReport(
      registryDiff,
      undefined,
      pluginDiffs,
      fullReportURL,
    )
    const fullReport = renderFullRegistryUpdateReport(registryDiff, undefined, pluginDiffs)
    expect(report.length).toBeLessThanOrEqual(MAX_REGISTRY_UPDATE_REPORT_LENGTH)
    expect(report).toContain('Report truncated at a complete review item boundary')
    expect(report).toContain('Plugin release details truncated at a complete Package boundary')
    expect(report).toContain(fullReportURL)
    expect(fullReport).toContain('plugin-99')
    expect(fullReport).toContain('example/tools-9')
    expect(fullReport).not.toContain('truncated at a complete Package boundary')
  })
})
