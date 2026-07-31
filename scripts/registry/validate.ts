import path from 'node:path'
import { loadSkillRegistryDefinitions } from '#registry/definitions/repository'
import { validateCommittedPlugins } from '#plugin/repository'
import { buildSkillRegistryCandidate } from '#registry/publish/candidate'
import { assertReleaseCandidate, loadRegistryReleaseLock } from '#registry/publish/release-lock'

const projectRoot = path.resolve(import.meta.dirname, '../..')
const [definitions, plugins] = await Promise.all([
  loadSkillRegistryDefinitions(projectRoot),
  validateCommittedPlugins(projectRoot),
])
await Promise.all(definitions.filter((definition) => definition.enabled).map(async (definition) => {
  const [lock, candidate] = await Promise.all([
    loadRegistryReleaseLock(projectRoot, definition),
    buildSkillRegistryCandidate(definition, projectRoot),
  ])
  assertReleaseCandidate(definition, lock, candidate.revision)
}))
console.log(`Validated ${definitions.length} Skill Registries: ${definitions.map((definition) => definition.id).join(', ')}`)
console.log(`Validated ${plugins.length} Plugins: ${plugins.join(', ')}`)
