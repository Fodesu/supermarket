import type { PluginReleaseCandidate } from '../release'
import { pluginSkillReferenceIdentity } from '../manifest'
import type { PluginResolvedSkill } from '../types'

export interface PluginSkillLockChange {
  identity: string
  registry_revision_before: string
  registry_revision_after: string
  artifact_before: string
  artifact_after: string
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
    const metadata = (['source_revision', 'install_id', 'runtime_requirements'] as const)
      .filter((field) => JSON.stringify(oldSkill[field]) !== JSON.stringify(newSkill[field]))
    if (oldSkill.registry_revision === newSkill.registry_revision
      && oldSkill.artifact.digest === newSkill.artifact.digest
      && !metadata.length) return []
    return [{
      identity,
      registry_revision_before: oldSkill.registry_revision,
      registry_revision_after: newSkill.registry_revision,
      artifact_before: oldSkill.artifact.digest,
      artifact_after: newSkill.artifact.digest,
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
      bundle_before: oldPlugin.artifact.descriptor.digest,
      bundle_after: newPlugin.artifact.descriptor.digest,
      skills: changedSkillLocks(oldPlugin, newPlugin),
    }]
  })
}

function shortDigest(value: string) {
  return `\`${value.slice(0, 12)}\``
}

export function renderPluginReleaseDiffs(diffs: PluginReleaseDiff[]) {
  if (!diffs.length) return ''
  const lines = [
    '## Affected Plugin releases',
    '',
    'These Plugin releases keep the same Plugin source and lock the approved Registry Skill Artifacts below.',
    '',
  ]
  for (const diff of diffs) {
    lines.push(`### \`${diff.plugin}\``, '')
    lines.push(`- Release: ${shortDigest(diff.release_before)} → ${shortDigest(diff.release_after)}`)
    lines.push(`- Bundle: ${shortDigest(diff.bundle_before)} → ${shortDigest(diff.bundle_after)}`)
    for (const skill of diff.skills) {
      lines.push(`- \`${skill.identity}\``)
      lines.push(`  - Registry Snapshot: ${shortDigest(skill.registry_revision_before)} → ${shortDigest(skill.registry_revision_after)}`)
      lines.push(`  - Skill Artifact: ${shortDigest(skill.artifact_before)} → ${shortDigest(skill.artifact_after)}`)
      if (skill.metadata.length) lines.push(`  - Metadata: ${skill.metadata.map((field) => `\`${field}\``).join(', ')}`)
    }
    lines.push('')
  }
  lines.push('Merging this PR approves both the Registry release and these pinned Plugin releases.', '')
  return lines.join('\n')
}
