import path from 'node:path'
import { loadSkillRegistryDefinitions } from '#registry/definitions/repository'
import {
  buildSkillRegistryCandidate,
  type SkillRegistryCandidate,
} from '#registry/publish/candidate'
import { assertReleaseCandidate, loadRegistryReleaseLock } from '#registry/publish/release-lock'
import { buildPluginReleaseCandidates } from '#plugin/release'
import { assertPluginReleaseCandidate, loadPluginReleaseLock } from '#plugin/release-lock'

const projectRoot = path.resolve(import.meta.dirname, '../..')
const definitions = await loadSkillRegistryDefinitions(projectRoot)
const candidates: Array<Pick<SkillRegistryCandidate, 'definition' | 'revision' | 'snapshot'>> = []
for (const definition of definitions.filter((item) => item.enabled)) {
  const lock = await loadRegistryReleaseLock(projectRoot, definition)
  const candidate = await buildSkillRegistryCandidate(definition, projectRoot)
  assertReleaseCandidate(definition, lock, candidate.revision)
  candidates.push({
    definition: candidate.definition,
    revision: candidate.revision,
    snapshot: candidate.snapshot,
  })
  candidate.artifacts.clear()
  candidate.images.clear()
  candidate.review.clear()
}
const plugins = await buildPluginReleaseCandidates(projectRoot, candidates.map((candidate) => ({
  revision: candidate.revision,
  snapshot: candidate.snapshot,
})))
for (const plugin of plugins) {
  const lock = await loadPluginReleaseLock(projectRoot, plugin.plugin_id)
  assertPluginReleaseCandidate(plugin.plugin_id, lock, plugin.revision)
}
console.log(`Validated ${definitions.length} Skill Registries: ${definitions.map((definition) => definition.id).join(', ')}`)
console.log(`Validated ${plugins.length} Plugin releases: ${plugins.map((plugin) => plugin.plugin_id).join(', ')}`)
