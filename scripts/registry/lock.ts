import path from 'node:path'
import { loadSkillRegistryDefinitions } from '#registry/definitions/repository'
import { writeRegistryReleaseLock } from '#registry/publish/release-lock'
import { buildSkillRegistryCandidate } from '#registry/publish/candidate'

function option(name: string) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const projectRoot = path.resolve(import.meta.dirname, '../..')
const selectedID = option('--registry')
const definitions = (await loadSkillRegistryDefinitions(projectRoot))
  .filter((definition) => !selectedID || definition.id === selectedID)

if (selectedID && !definitions.length) {
  throw new Error(`Registry not found: ${selectedID}`)
}

for (const definition of definitions) {
  const candidate = await buildSkillRegistryCandidate(definition, projectRoot)
  await writeRegistryReleaseLock(projectRoot, definition, {
    snapshot_revision: candidate.revision,
  })
  console.log(`${definition.id}: wrote release.lock.json ${candidate.revision}`)
}
