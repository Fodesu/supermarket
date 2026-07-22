import path from 'node:path'
import { loadSkillRegistryDefinitions, SkillRegistryRefresher } from './skill-registry/refresher'
import { createSkillRegistryStore } from './skill-registry/store'

function option(name: string) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const projectRoot = path.resolve(import.meta.dirname, '..')
const registryID = option('--registry')
const packageID = option('--package')
const skillID = option('--skill')
if (skillID && !packageID) throw new Error('--skill requires --package')
if ((packageID || skillID) && !registryID) throw new Error('--package and --skill require --registry')

const definitions = await loadSkillRegistryDefinitions(projectRoot)
const selected = registryID ? definitions.filter((definition) => definition.id === registryID) : definitions
if (registryID && selected.length === 0) throw new Error(`Registry not found: ${registryID}`)
const refresher = new SkillRegistryRefresher(createSkillRegistryStore(projectRoot), projectRoot)
for (const definition of selected) {
  console.log(await refresher.refresh(definition, {
    package: packageID, skill: skillID, force: process.argv.includes('--force'),
  }))
}
