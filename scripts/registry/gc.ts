import path from 'node:path'
import { LocalSkillRegistryStore } from '#registry/storage/local'
import { garbageCollectSkillRegistries } from '#registry/maintenance/gc'
import { loadSkillRegistryDefinitions } from '#registry/definitions/repository'
import { acquireRegistryWriterLock } from '#registry/maintenance/writer-lock'

if (import.meta.main) {
  const supported = new Set(['--apply'])
  const unsupported = process.argv.slice(2).filter((argument) => argument.startsWith('--') && !supported.has(argument))
  if (unsupported.length) throw new Error(`Unsupported registry:gc option: ${unsupported[0]}`)

  const projectRoot = path.resolve(import.meta.dirname, '../..')
  if (process.env.REGISTRY_R2_INTERNAL_URL) {
    throw new Error('registry:gc is local-only and cannot use the deployed Writer Store')
  }
  const store = new LocalSkillRegistryStore(
    process.env.REGISTRY_DATA_DIR || path.join(projectRoot, '.data/registries'),
  )
  const apply = process.argv.includes('--apply')
  const writerLock = apply
    ? await acquireRegistryWriterLock(process.env.REGISTRY_REFRESH_LOCK_DIR || path.join(projectRoot, '.data/registry-refresh.lock'))
    : undefined
  try {
    const result = await garbageCollectSkillRegistries({
      store,
      definitions: await loadSkillRegistryDefinitions(projectRoot),
      apply,
      assertWriterActive: writerLock ? () => writerLock.assertActive() : undefined,
    })
    console.log(JSON.stringify(result, null, 2))
  } finally {
    await writerLock?.release()
  }
}
