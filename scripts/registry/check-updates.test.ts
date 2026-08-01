import { describe, expect, test } from 'bun:test'
import type { PluginReleaseDiff } from '#plugin/review/release-diff'
import type { RegistryReleaseDiff } from '#registry/review/release-diff'
import {
  MAX_REGISTRY_UPDATE_REPORT_LENGTH,
  renderFullRegistryUpdateReport,
  renderPluginReviewComments,
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
        packages_changed: 1,
        skills_added: 0,
        skills_removed: 0,
        skills_changed: 100,
      },
    }
    const artifact = {
      format: 'memoh_skill_v1' as const,
      digest: 'c'.repeat(64),
      size: 1,
      uncompressed_size: 1,
      archive_size: 1,
      file_count: 1,
      content_type: 'application/gzip' as const,
    }
    const pluginDiffs: PluginReleaseDiff[] = Array.from({ length: 100 }, (_, index) => ({
      plugin: `plugin-${index}`,
      release_before: 'd'.repeat(64),
      release_after: 'e'.repeat(64),
      bundle_before: 'f'.repeat(64),
      bundle_after: '0'.repeat(64),
      skills: Array.from({ length: 10 }, (_, skillIndex) => ({
        identity: `example/tools/skill-${skillIndex}`,
        registry_revision_before: '1'.repeat(64),
        registry_revision_after: '2'.repeat(64),
        artifact_before: artifact,
        artifact_after: { ...artifact, digest: '3'.repeat(64) },
        metadata: [],
      })),
    }))

    const fullReportURL = 'https://github.example/actions/runs/123#artifacts'
    const report = renderRegistryUpdateReport(
      registryDiff,
      undefined,
      pluginDiffs,
      fullReportURL,
      true,
    )
    const fullReport = renderFullRegistryUpdateReport(registryDiff, undefined, pluginDiffs)
    const comments = renderPluginReviewComments(pluginDiffs, `example:${'2'.repeat(40)}`)
    expect(report.length).toBeLessThanOrEqual(MAX_REGISTRY_UPDATE_REPORT_LENGTH)
    expect(report).toContain('Report truncated at a complete Skill boundary')
    expect(report).toContain('Plugin release details truncated at a complete Skill boundary')
    expect(report).toContain(fullReportURL)
    expect(report).toContain('persistent Full Plugin Skill descriptor report comments')
    expect(fullReport).toContain('plugin-99')
    expect(fullReport).toContain('example/tools/skill-9')
    expect(fullReport).not.toContain('truncated at a complete Skill boundary')
    expect(comments.length).toBeGreaterThan(1)
    expect(comments.every((comment) => comment.length <= MAX_REGISTRY_UPDATE_REPORT_LENGTH)).toBe(true)
    expect(comments[0]).toContain('registry-plugin-review:example:')
    expect(comments.join('\n')).toContain('plugin-99')
    expect(comments.join('\n')).toContain('example/tools/skill-9')
  })
})
