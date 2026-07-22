import path from 'node:path'
import type { SkillRegistryDefinition } from '../server/types/skill-registry'
import type { SkillRegistryStore } from '../server/utils/skill-registry-store'
import { isSkillRegistryRefreshDue, loadSkillRegistryDefinitionResults, SkillRegistryRefresher } from './skill-registry/refresher'
import { acquireProcessLock } from './skill-registry/process-lock'
import { createSkillRegistryStore } from './skill-registry/store'

interface RefreshRunner {
  refresh(
    definition: SkillRegistryDefinition,
    options: { package?: string; skill?: string; force?: boolean },
  ): Promise<unknown>
}

export async function runSkillRegistryRefreshes(input: {
  definitions: SkillRegistryDefinition[]
  store: Pick<SkillRegistryStore, 'getDefinition' | 'getStatus'>
  refresher: RefreshRunner
  due?: boolean
  force?: boolean
  package?: string
  skill?: string
}) {
  const results: unknown[] = []
  const failures: Array<{ registry: string; error: unknown }> = []
  for (const definition of input.definitions) {
    try {
      const [storedDefinition, status] = await Promise.all([
        input.store.getDefinition(definition.id), input.store.getStatus(definition.id),
      ])
      const definitionChanged = JSON.stringify(storedDefinition) !== JSON.stringify(definition)
      if (input.due && !input.force && !definitionChanged) {
        const alreadyDisabled = !definition.enabled && status?.state === 'disabled'
        if (alreadyDisabled || !isSkillRegistryRefreshDue(definition, status)) {
          results.push({ registry: definition.id, skipped: alreadyDisabled ? 'disabled' : 'not_due' })
          continue
        }
      }
      results.push(await input.refresher.refresh(definition, {
        package: input.package, skill: input.skill, force: input.force,
      }))
    } catch (error) {
      failures.push({ registry: definition.id, error })
    }
  }
  return { results, failures }
}

function option(name: string) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

if (import.meta.main) {
  const projectRoot = path.resolve(import.meta.dirname, '..')
  const registryID = option('--registry')
  const packageID = option('--package')
  const skillID = option('--skill')
  if (skillID && !packageID) throw new Error('--skill requires --package')
  if ((packageID || skillID) && !registryID) throw new Error('--package and --skill require --registry')

  const lockPath = process.env.REGISTRY_REFRESH_LOCK_DIR || path.join(projectRoot, '.data/registry-refresh.lock')
  const releaseLock = await acquireProcessLock(lockPath)
  try {
    const loaded = await loadSkillRegistryDefinitionResults(projectRoot)
    const selected = registryID ? loaded.definitions.filter((definition) => definition.id === registryID) : loaded.definitions
    const definitionFailures = registryID
      ? loaded.failures.filter((failure) => failure.registry === registryID)
      : loaded.failures
    if (registryID && selected.length === 0 && definitionFailures.length === 0) throw new Error(`Registry not found: ${registryID}`)
    const store = createSkillRegistryStore(projectRoot)
    const outcome = await runSkillRegistryRefreshes({
      definitions: selected, store, refresher: new SkillRegistryRefresher(store, projectRoot),
      due: process.argv.includes('--due'), force: process.argv.includes('--force'),
      package: packageID, skill: skillID,
    })
    for (const result of outcome.results) console.log(result)
    const failures = [
      ...definitionFailures.map((failure) => ({ registry: failure.registry, error: failure.error })),
      ...outcome.failures,
    ]
    for (const failure of failures) {
      console.error({
        registry: failure.registry,
        error: failure.error instanceof Error ? failure.error.message : String(failure.error),
      })
    }
    if (failures.length) process.exitCode = 1
  } finally {
    await releaseLock()
  }
}
