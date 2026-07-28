import { assertRegistryID } from '../definition'
import type { SkillRegistryCatalog } from '../types'
import { assertDigest, BlobSkillRegistryStore, validateStoredCatalog } from './blob'
import type {
  MaintenanceBlobBackend,
  SkillRegistryMaintenanceStore,
} from './contracts'

const decoder = new TextDecoder()

export class BlobSkillRegistryMaintenanceStore
  extends BlobSkillRegistryStore
  implements SkillRegistryMaintenanceStore {
  declare protected readonly backend: MaintenanceBlobBackend

  constructor(backend: MaintenanceBlobBackend) {
    super(backend)
  }

  async listSnapshots(registryID: string) {
    const id = assertRegistryID(registryID, 'registry ID')
    const prefix = `skill-registries/${id}/snapshots/`
    const keys = await this.backend.list(prefix)
    const unexpected = keys.find((key) =>
      !key.startsWith(prefix) || !/^[a-f0-9]{64}\.json$/.test(key.slice(prefix.length)))
    if (unexpected) throw new Error(`Unexpected object in Snapshot namespace: ${unexpected}`)
    return Promise.all(keys.map(async (key) => {
      const revision = key.slice(prefix.length, -'.json'.length)
      const bytes = await this.backend.get(key)
      if (!bytes) throw new Error(`Snapshot disappeared while listing: ${key}`)
      const catalog = JSON.parse(decoder.decode(bytes)) as SkillRegistryCatalog
      validateStoredCatalog(catalog, id, revision, key)
      return catalog
    }))
  }

  async deleteSnapshot(registryID: string, revision: string) {
    const id = assertRegistryID(registryID, 'registry ID')
    const digest = assertDigest(revision)
    const state = await this.getState(id)
    if (state?.current_snapshot === digest) {
      throw new Error(`Cannot delete current Snapshot: ${id}/${digest}`)
    }
    await this.backend.delete(`skill-registries/${id}/snapshots/${digest}.json`)
  }

  async listArtifactDigests() {
    const keys = await this.backend.list('skill-artifacts/')
    return [...new Set(keys.flatMap((key): string[] => {
      const match = key.match(/^skill-artifacts\/([a-f0-9]{64})\.tar\.gz$/)
      return match?.[1] ? [match[1]] : []
    }))].sort()
  }

  async deleteArtifact(digest: string) {
    await this.backend.delete(`skill-artifacts/${assertDigest(digest)}.tar.gz`)
  }

  async listImageDigests() {
    const keys = await this.backend.list('skill-images/')
    return [...new Set(keys.flatMap((key): string[] => {
      const match = key.match(/^skill-images\/([a-f0-9]{64})(?:\.json)?$/)
      return match?.[1] ? [match[1]] : []
    }))].sort()
  }

  async deleteImage(digest: string) {
    const value = assertDigest(digest)
    await this.backend.delete(`skill-images/${value}.json`)
    await this.backend.delete(`skill-images/${value}`)
  }
}
