import path from 'node:path'
import { loadSkillRegistryDefinitions } from './skill-registry/refresher'

const projectRoot = path.resolve(import.meta.dirname, '..')
const definitions = await loadSkillRegistryDefinitions(projectRoot)
console.log(`Validated ${definitions.length} Skill Registries: ${definitions.map((definition) => definition.id).join(', ')}`)
