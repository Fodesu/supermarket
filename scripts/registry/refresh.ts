import path from 'node:path'
import type { SkillRegistryDefinition } from '#registry/types'
import { IndeterminateRemoteMutationError, type SkillRegistryStore } from '#registry/storage/contracts'
import {
  isSkillRegistryRefreshDue,
  loadSkillRegistryDefinitionResults,
  SkillRegistryRefresher,
  type SkillRegistryRefreshProgress,
} from '#registry/refresh/refresher'
import { createSkillRegistryStore } from './runtime'
import { acquireRegistryWriterLock } from '#registry/maintenance/writer-lock'

export function createSkillRegistryProgressRenderer(
  write: (text: string) => void = (text) => process.stderr.write(text),
  interactive = process.stderr.isTTY === true,
) {
  let openLine = false
  const line = (text: string) => {
    if (openLine) {
      write('\n')
      openLine = false
    }
    write(`${text}\n`)
  }
  return (progress: SkillRegistryRefreshProgress) => {
    switch (progress.type) {
      case 'source':
        line(`${progress.registry}: fetching source`)
        break
      case 'source_ready':
        line(`${progress.registry}: source revision ${progress.revision.slice(0, 12)}`)
        break
      case 'scanned':
        line(`${progress.registry}: packaging ${progress.skills} Skills (${progress.diagnostics} diagnostics)`)
        break
      case 'skill': {
        const text = `${progress.registry}: [${progress.index}/${progress.total}] ${progress.package_id}/${progress.skill_id}${progress.uploaded ? ' (uploaded)' : ''}`
        if (interactive) {
          write(`\r\u001B[2K${text}`)
          openLine = progress.index !== progress.total
          if (!openLine) write('\n')
        } else if (progress.uploaded || progress.index % 25 === 0 || progress.index === progress.total) {
          line(text)
        }
        break
      }
      case 'publishing':
        line(`${progress.registry}: publishing revision ${progress.revision.slice(0, 12)}`)
        break
    }
  }
}

interface RefreshRunner {
  refresh(
    definition: SkillRegistryDefinition,
    options: { package?: string; skill?: string },
  ): Promise<unknown>
}

export async function runSkillRegistryRefreshes(input: {
  definitions: SkillRegistryDefinition[]
  store: Pick<SkillRegistryStore, 'getState'>
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
      const state = await input.store.getState(definition.id)
      const definitionChanged = JSON.stringify(state?.definition) !== JSON.stringify(definition)
      if (input.due && !input.force && !definitionChanged) {
        const alreadyDisabled = !definition.enabled && state?.status.state === 'disabled'
        if (alreadyDisabled || !isSkillRegistryRefreshDue(definition, state?.status ?? null)) {
          results.push({ registry: definition.id, skipped: alreadyDisabled ? 'disabled' : 'not_due' })
          continue
        }
      }
      results.push(await input.refresher.refresh(definition, {
        package: input.package, skill: input.skill,
      }))
    } catch (error) {
      if (error instanceof IndeterminateRemoteMutationError) throw error
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
  const projectRoot = path.resolve(import.meta.dirname, '../..')
  const registryID = option('--registry')
  const packageID = option('--package')
  const skillID = option('--skill')
  if (skillID && !packageID) throw new Error('--skill requires --package')
  if ((packageID || skillID) && !registryID) throw new Error('--package and --skill require --registry')

  const lockPath = process.env.REGISTRY_REFRESH_LOCK_DIR || path.join(projectRoot, '.data/registry-refresh.lock')
  const store = createSkillRegistryStore(projectRoot)
  const writerLock = await acquireRegistryWriterLock(lockPath)
  try {
    const loaded = await loadSkillRegistryDefinitionResults(projectRoot)
    const selected = registryID ? loaded.definitions.filter((definition) => definition.id === registryID) : loaded.definitions
    const definitionFailures = registryID
      ? loaded.failures.filter((failure) => failure.registry === registryID)
      : loaded.failures
    if (registryID && selected.length === 0 && definitionFailures.length === 0) throw new Error(`Registry not found: ${registryID}`)
    const outcome = await runSkillRegistryRefreshes({
      definitions: selected, store,
      refresher: new SkillRegistryRefresher(
        store, projectRoot, () => writerLock.assertActive(), createSkillRegistryProgressRenderer(),
      ),
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
    const indeterminate = failures.find((failure) => failure.error instanceof IndeterminateRemoteMutationError)
    if (indeterminate) throw indeterminate.error
    if (failures.length) process.exitCode = 1
  } finally {
    await writerLock.release()
  }
}
