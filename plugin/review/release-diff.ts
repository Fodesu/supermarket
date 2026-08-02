import type { PluginReleaseCandidate } from '../release'
import { pluginSkillReferenceIdentity } from '../manifest'
import type { PluginResolvedSkill } from '../types'
import type { SkillArtifactDescriptor } from '#registry/types'
import {
  appendMarkdownLines,
  combinedMarkdownLength,
  markdownLines,
  renderMarkdownLines,
} from '#lib/markdown-lines'

export interface PluginSkillLockChange {
  identity: string
  registry_revision_before: string
  registry_revision_after: string
  artifact_before: SkillArtifactDescriptor
  artifact_after: SkillArtifactDescriptor
  metadata: string[]
}

export interface PluginReleaseDiff {
  plugin: string
  release_before: string
  release_after: string
  bundle_before: string
  bundle_after: string
  skills: PluginSkillLockChange[]
}

function skillIndex(skills: PluginResolvedSkill[]) {
  return new Map(skills.map((skill) => [pluginSkillReferenceIdentity(skill), skill]))
}

function changedSkillLocks(
  previous: PluginReleaseCandidate,
  candidate: PluginReleaseCandidate,
) {
  const before = skillIndex(previous.release.skills)
  const after = skillIndex(candidate.release.skills)
  const identities = new Set([...before.keys(), ...after.keys()])
  return [...identities].sort().flatMap((identity): PluginSkillLockChange[] => {
    const oldSkill = before.get(identity)
    const newSkill = after.get(identity)
    if (!oldSkill || !newSkill) throw new Error(`${candidate.plugin_id}: Plugin Skill references changed while reviewing a Registry update`)
    const metadata = (['source_revision', 'install_id'] as const)
      .filter((field) => JSON.stringify(oldSkill[field]) !== JSON.stringify(newSkill[field]))
    if (oldSkill.registry_revision === newSkill.registry_revision
      && JSON.stringify(oldSkill.artifact) === JSON.stringify(newSkill.artifact)
      && !metadata.length) return []
    return [{
      identity,
      registry_revision_before: oldSkill.registry_revision,
      registry_revision_after: newSkill.registry_revision,
      artifact_before: oldSkill.artifact,
      artifact_after: newSkill.artifact,
      metadata: [...metadata],
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
      skills: changedSkillLocks(oldPlugin, newPlugin),
    }]
  })
}

function shortDigest(value: string) {
  return `\`${value.slice(0, 12)}\``
}

function artifactLabel(artifact: SkillArtifactDescriptor) {
  return `${shortDigest(artifact.digest)} (${artifact.format}, ${artifact.size} B)`
}

function skillLines(skill: PluginSkillLockChange) {
  const lines = [
    `- \`${skill.identity}\``,
    `  - Registry Snapshot: ${shortDigest(skill.registry_revision_before)} → ${shortDigest(skill.registry_revision_after)}`,
    `  - Skill Artifact: ${artifactLabel(skill.artifact_before)} → ${artifactLabel(skill.artifact_after)}`,
  ]
  if (skill.metadata.length) {
    lines.push(`  - Metadata: ${skill.metadata.map((field) => `\`${field}\``).join(', ')}`)
  }
  return lines
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
  const truncationNotice = `_Plugin release details truncated at a complete Skill boundary.${artifactNotice}_`
  const reservedFooter = approvalNotice.length >= truncationNotice.length
    ? approvalNotice
    : truncationNotice
  const output = markdownLines([
    '## Affected Plugin releases',
    '',
    'These Plugin releases keep the same Plugin source and lock the approved Registry Skill Artifacts below.',
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
    for (const skill of diff.skills) {
      const skillBlock = markdownLines(skillLines(skill))
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
