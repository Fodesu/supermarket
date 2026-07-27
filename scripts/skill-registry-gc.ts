import path from 'node:path'
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
    ? await acquireRegistryWriterLock(process.env.REGISTRY_REFRESH_LOCK_DIR || path.join(projectRoot, '.data/registry-refresh.lock'))
    : undefined
  try {
    const result = await garbageCollectSkillRegistries({
      store,
      definitions: await loadSkillRegistryDefinitions(projectRoot),
      apply,
      assertWriterLease: writerLock ? () => writerLock.assertActive() : undefined,
    })
    console.log(JSON.stringify(result, null, 2))
  } finally {
    await writerLock?.release()
  }
}
