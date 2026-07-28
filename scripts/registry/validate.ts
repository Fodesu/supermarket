import path from 'node:path'
import { loadSkillRegistryDefinitions } from '#registry/refresh/refresher'

const projectRoot = path.resolve(import.meta.dirname, '../..')
const definitions = await loadSkillRegistryDefinitions(projectRoot)
console.log(`Validated ${definitions.length} Skill Registries: ${definitions.map((definition) => definition.id).join(', ')}`)
