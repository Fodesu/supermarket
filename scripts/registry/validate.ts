import path from 'node:path'
import { loadSkillRegistryDefinitions } from '#registry/definitions/repository'
import { validateCommittedPlugins } from '#plugin/repository'

const projectRoot = path.resolve(import.meta.dirname, '../..')
const [definitions, plugins] = await Promise.all([
  loadSkillRegistryDefinitions(projectRoot),
  validateCommittedPlugins(projectRoot),
])
console.log(`Validated ${definitions.length} Skill Registries: ${definitions.map((definition) => definition.id).join(', ')}`)
console.log(`Validated ${plugins.length} Plugins: ${plugins.join(', ')}`)
