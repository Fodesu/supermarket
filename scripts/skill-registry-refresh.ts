import path from 'node:path'
import { isSkillRegistryRefreshDue, loadSkillRegistryDefinitions, SkillRegistryRefresher } from './skill-registry/refresher'
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
const store = createSkillRegistryStore(projectRoot)
const refresher = new SkillRegistryRefresher(store, projectRoot)
for (const definition of selected) {
  if (process.argv.includes('--due') && !process.argv.includes('--force')) {
    const status = await store.getStatus(definition.id)
    if (!isSkillRegistryRefreshDue(definition, status)) {
      console.log({ registry: definition.id, skipped: 'not_due' })
      continue
    }
  }
  console.log(await refresher.refresh(definition, {
    package: packageID, skill: skillID, force: process.argv.includes('--force'),
  }))
}
