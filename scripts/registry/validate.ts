import path from 'node:path'
import { loadSkillRegistryDefinitions } from '#registry/definitions/repository'
import { buildSkillRegistryCandidate } from '#registry/publish/candidate'
import { assertReleaseCandidate, loadRegistryReleaseLock } from '#registry/publish/release-lock'
import { buildPluginReleaseCandidates } from '#plugin/release'
import { assertPluginReleaseCandidate, loadPluginReleaseLock } from '#plugin/release-lock'

const projectRoot = path.resolve(import.meta.dirname, '../..')
const definitions = await loadSkillRegistryDefinitions(projectRoot)
const candidates = await Promise.all(definitions.filter((definition) => definition.enabled).map(async (definition) => {
  const [lock, candidate] = await Promise.all([
    loadRegistryReleaseLock(projectRoot, definition),
    buildSkillRegistryCandidate(definition, projectRoot),
  ])
  assertReleaseCandidate(definition, lock, candidate.revision)
  return candidate
}))
const plugins = await buildPluginReleaseCandidates(projectRoot, candidates.map((candidate) => ({
  revision: candidate.revision,
  snapshot: candidate.snapshot,
})))
await Promise.all(plugins.map(async (plugin) => {
  const lock = await loadPluginReleaseLock(projectRoot, plugin.plugin_id)
  assertPluginReleaseCandidate(plugin.plugin_id, lock, plugin.revision)
}))
console.log(`Validated ${definitions.length} Skill Registries: ${definitions.map((definition) => definition.id).join(', ')}`)
console.log(`Validated ${plugins.length} Plugin releases: ${plugins.map((plugin) => plugin.plugin_id).join(', ')}`)
