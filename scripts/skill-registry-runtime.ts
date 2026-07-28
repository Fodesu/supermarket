import path from 'node:path'
import { BlobSkillRegistryStore } from '#registry/storage/blob'
import type { SkillRegistryStore } from '#registry/storage/contracts'
import { LocalSkillRegistryStore } from '#registry/storage/local'
import { WorkerR2BlobBackend } from '#registry/storage/worker-r2'

export function createSkillRegistryStore(projectRoot: string): SkillRegistryStore {
  const internalURL = process.env.REGISTRY_R2_INTERNAL_URL
  if (internalURL) return new BlobSkillRegistryStore(new WorkerR2BlobBackend(internalURL))
  return new LocalSkillRegistryStore(
    process.env.REGISTRY_DATA_DIR || path.join(projectRoot, '.data/registries'),
  )
}
