import path from 'node:path'
import { BlobSkillRegistryStore } from '#registry/storage/blob'
import type { SkillRegistryStore } from '#registry/storage/contracts'
import { LocalSkillRegistryStore } from '#registry/storage/local'
import { WorkerR2BlobBackend } from '#registry/storage/worker-r2'

interface RegistryRuntimeEnvironment {
  [name: string]: string | undefined
  REGISTRY_BLOBS_URL?: string
  REGISTRY_STATE_URL?: string
  REGISTRY_WRITER_TOKEN?: string
  REGISTRY_DATA_DIR?: string
}

export function createSkillRegistryStore(
  projectRoot: string,
  environment: RegistryRuntimeEnvironment = process.env,
): SkillRegistryStore {
  const blobsURL = environment.REGISTRY_BLOBS_URL
  const coordinatedValues = [
    blobsURL,
    environment.REGISTRY_STATE_URL,
    environment.REGISTRY_WRITER_TOKEN,
  ]
  if (coordinatedValues.some(Boolean) && !coordinatedValues.every(Boolean)) {
    throw new Error(
      'Incomplete coordinated Registry Writer configuration: '
      + 'REGISTRY_BLOBS_URL, REGISTRY_STATE_URL, and REGISTRY_WRITER_TOKEN are all required',
    )
  }
  if (blobsURL) return new BlobSkillRegistryStore(new WorkerR2BlobBackend(blobsURL))
  return new LocalSkillRegistryStore(
    environment.REGISTRY_DATA_DIR || path.join(projectRoot, '.data/registries'),
  )
}
