import path from 'node:path'
import { IndeterminateRemoteMutationError } from '../server/utils/skill-registry-store'
import { garbageCollectSkillRegistries } from './skill-registry/gc'
import { loadSkillRegistryDefinitions } from './skill-registry/refresher'
import { createSkillRegistryStore } from './skill-registry/store'
import { acquireRegistryWriterLock } from './skill-registry/writer-lock'

if (import.meta.main) {
  const supported = new Set(['--apply'])
  const unsupported = process.argv.slice(2).filter((argument) => argument.startsWith('--') && !supported.has(argument))
  if (unsupported.length) throw new Error(`Unsupported registry:gc option: ${unsupported[0]}`)

  const projectRoot = path.resolve(import.meta.dirname, '..')
  const store = createSkillRegistryStore(projectRoot)
  const apply = process.argv.includes('--apply')
  const writerLock = apply
    ? await acquireRegistryWriterLock(
        store,
        process.env.REGISTRY_REFRESH_LOCK_DIR || path.join(projectRoot, '.data/registry-refresh.lock'),
        `registry:gc pid=${process.pid}`,
      )
    : undefined
  try {
    const result = await garbageCollectSkillRegistries({
      store,
      definitions: await loadSkillRegistryDefinitions(projectRoot),
      apply,
      assertWriterLease: writerLock ? () => writerLock.assertActive() : undefined,
    })
    console.log(JSON.stringify(result, null, 2))
  } catch (error) {
    if (error instanceof IndeterminateRemoteMutationError) {
      const owner = writerLock?.owner
      writerLock?.abandon()
      throw new Error(`${error.message}; writer lease ${owner} remains active until it expires, the remote request is confirmed finished, and registry:unlock -- --owner ${owner} --confirm-owner-stopped is run`, { cause: error })
    }
    throw error
  } finally {
    await writerLock?.release()
  }
}
