import type { PluginReleaseCandidate } from '../release'
import { pluginPackageReferenceIdentity } from '../manifest'
import type { PluginResolvedPackage } from '../types'
import {
  appendMarkdownLines,
  combinedMarkdownLength,
  markdownLines,
  renderMarkdownLines,
} from '#lib/markdown-lines'

export interface PluginPackageLockChange {
  identity: string
  revision_before: string
  revision_after: string
}

export interface PluginReleaseDiff {
  plugin: string
  release_before: string
  release_after: string
  bundle_before: string
  bundle_after: string
  packages: PluginPackageLockChange[]
}

function packageIndex(packages: PluginResolvedPackage[]) {
  return new Map(packages.map((pkg) => [pluginPackageReferenceIdentity(pkg), pkg]))
}

function changedPackageLocks(
  previous: PluginReleaseCandidate,
  candidate: PluginReleaseCandidate,
) {
  const before = packageIndex(previous.release.packages)
  const after = packageIndex(candidate.release.packages)
  const identities = new Set([...before.keys(), ...after.keys()])
  return [...identities].sort().flatMap((identity): PluginPackageLockChange[] => {
    const oldPackage = before.get(identity)
    const newPackage = after.get(identity)
    if (!oldPackage || !newPackage) throw new Error(`${candidate.plugin_id}: Plugin Package references changed while reviewing a Registry update`)
    if (oldPackage.revision === newPackage.revision) return []
    return [{
      identity,
      revision_before: oldPackage.revision,
      revision_after: newPackage.revision,
    }]
  })
}

export function diffPluginReleaseCandidates(
  previous: PluginReleaseCandidate[],
  candidate: PluginReleaseCandidate[],
) {
  const before = new Map(previous.map((plugin) => [plugin.plugin_id, plugin]))
  const after = new Map(candidate.map((plugin) => [plugin.plugin_id, plugin]))
  if (before.size !== after.size || [...before.keys()].some((id) => !after.has(id))) {
    throw new Error('Plugin repository changed while reviewing a Registry update')
  }
  return [...after.keys()].sort().flatMap((pluginID): PluginReleaseDiff[] => {
    const oldPlugin = before.get(pluginID)!
    const newPlugin = after.get(pluginID)!
    if (oldPlugin.revision === newPlugin.revision) return []
    return [{
      plugin: pluginID,
      release_before: oldPlugin.revision,
      release_after: newPlugin.revision,
      bundle_before: oldPlugin.release.artifact.digest,
      bundle_after: newPlugin.release.artifact.digest,
      packages: changedPackageLocks(oldPlugin, newPlugin),
    }]
  })
}

function shortDigest(value: string) {
  return `\`${value.slice(0, 12)}\``
}

function packageLines(pkg: PluginPackageLockChange) {
  return [
    `- \`${pkg.identity}\``,
    `  - Package release: ${shortDigest(pkg.revision_before)} → ${shortDigest(pkg.revision_after)}`,
  ]
}

export function renderPluginReleaseDiffs(
  diffs: PluginReleaseDiff[],
  maximum = 20_000,
  fullReportURL?: string,
) {
  if (!diffs.length) return ''
  const approvalNotice = 'Merging this PR approves both the Registry release and these pinned Plugin releases.'
  const artifactNotice = fullReportURL
    ? ` [Download the full workflow report](${fullReportURL}) while it is retained.`
    : ''
  const truncationNotice = `_Plugin release details truncated at a complete Package boundary.${artifactNotice}_`
  const reservedFooter = approvalNotice.length >= truncationNotice.length
    ? approvalNotice
    : truncationNotice
  const output = markdownLines([
    '## Affected Plugin releases',
    '',
    'These Plugin releases keep the same Plugin source and lock the approved Package releases below.',
    '',
  ])
  let truncated = false
  outer: for (const diff of diffs) {
    const pluginBlock = markdownLines([
      `### \`${diff.plugin}\``,
      '',
      `- Release: ${shortDigest(diff.release_before)} → ${shortDigest(diff.release_after)}`,
      `- Bundle: ${shortDigest(diff.bundle_before)} → ${shortDigest(diff.bundle_after)}`,
    ])
    if (combinedMarkdownLength(
      output,
      pluginBlock,
      markdownLines(['', reservedFooter, '']),
    ) > maximum) {
      truncated = true
      break
    }
    for (const pkg of diff.packages) {
      const skillBlock = markdownLines(packageLines(pkg))
      if (combinedMarkdownLength(
        output,
        pluginBlock,
        skillBlock,
        markdownLines(['', reservedFooter, '']),
      ) > maximum) {
        truncated = true
        appendMarkdownLines(pluginBlock, markdownLines(['']))
        appendMarkdownLines(output, pluginBlock)
        break outer
      }
      appendMarkdownLines(pluginBlock, skillBlock)
    }
    appendMarkdownLines(pluginBlock, markdownLines(['']))
    appendMarkdownLines(output, pluginBlock)
  }
  appendMarkdownLines(output, markdownLines([truncated ? truncationNotice : approvalNotice, '']))
  return renderMarkdownLines(output)
}
