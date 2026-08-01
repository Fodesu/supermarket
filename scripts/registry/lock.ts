import path from 'node:path'
import { loadSkillRegistryDefinitions } from '#registry/definitions/repository'
import { writeRegistryReleaseLock } from '#registry/publish/release-lock'
import {
  buildSkillRegistryCandidate,
  type SkillRegistryCandidate,
} from '#registry/publish/candidate'
import { buildPluginReleaseCandidates } from '#plugin/release'
import { writePluginReleaseLock } from '#plugin/release-lock'

function option(name: string) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const projectRoot = path.resolve(import.meta.dirname, '../..')
const selectedRegistry = option('--registry')
const selectedPlugin = option('--plugin')
const definitions = await loadSkillRegistryDefinitions(projectRoot)

if (selectedRegistry && !definitions.some((definition) => definition.id === selectedRegistry)) {
  throw new Error(`Registry not found: ${selectedRegistry}`)
}

const candidates: Array<Pick<SkillRegistryCandidate, 'definition' | 'revision' | 'snapshot'>> = []
for (const definition of definitions.filter((item) => item.enabled)) {
  const candidate = await buildSkillRegistryCandidate(definition, projectRoot)
  candidates.push({
    definition: candidate.definition,
    revision: candidate.revision,
    snapshot: candidate.snapshot,
  })
  candidate.artifacts.clear()
  candidate.images.clear()
  candidate.review.clear()
}

if (!selectedPlugin) {
  for (const candidate of candidates) {
    if (selectedRegistry && candidate.definition.id !== selectedRegistry) continue
    await writeRegistryReleaseLock(projectRoot, candidate.definition, {
      snapshot_revision: candidate.revision,
    })
    console.log(`${candidate.definition.id}: wrote Registry release.lock.json ${candidate.revision}`)
  }
}

const plugins = await buildPluginReleaseCandidates(projectRoot, candidates.map((candidate) => ({
  revision: candidate.revision,
  snapshot: candidate.snapshot,
})))
if (selectedPlugin && !plugins.some((plugin) => plugin.plugin_id === selectedPlugin)) {
  throw new Error(`Plugin not found: ${selectedPlugin}`)
}
for (const plugin of plugins) {
  if (selectedPlugin && plugin.plugin_id !== selectedPlugin) continue
  await writePluginReleaseLock(projectRoot, plugin.plugin_id, {
    release_revision: plugin.revision,
  })
  console.log(`${plugin.plugin_id}: wrote Plugin release.lock.json ${plugin.revision}`)
}
