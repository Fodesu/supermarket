import type {
  SkillArtifactBlob,
  SkillArtifactDescriptor,
  SkillImageAsset,
  SkillRegistryCatalog,
  SkillRegistryState,
} from '../types'

export class IndeterminateRemoteMutationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'IndeterminateRemoteMutationError'
  }
}

export interface BlobBackend {
  get(key: string): Promise<Uint8Array | null>
  put(key: string, value: Uint8Array): Promise<void>
  list(prefix: string): Promise<string[]>
  listPrefixes(prefix: string): Promise<string[]>
  getStream?(key: string): Promise<{ body: ReadableStream<Uint8Array>; size?: number } | null>
  putConditional?(key: string, value: Uint8Array, expectedVersion: string | null): Promise<string | null>
}

export interface MaintenanceBlobBackend extends BlobBackend {
  delete(key: string): Promise<void>
}

export interface SkillRegistryStore {
  listRegistryIDs(): Promise<string[]>
  getState(registryID: string): Promise<SkillRegistryState | null>
  putState(state: SkillRegistryState): Promise<void>
  getSnapshot(registryID: string, revision: string): Promise<SkillRegistryCatalog | null>
  publishSnapshot(
    catalog: SkillRegistryCatalog,
    state: SkillRegistryState,
    assertWriterActive?: () => void,
  ): Promise<void>
  putArtifact(descriptor: SkillArtifactDescriptor, bytes: Uint8Array): Promise<{ stored: boolean }>
  getArtifact(digest: string): Promise<{ descriptor: SkillArtifactBlob; bytes: Uint8Array } | null>
  getArtifactStream?(digest: string): Promise<{
    descriptor: SkillArtifactBlob
    body: ReadableStream<Uint8Array> | Uint8Array
  } | null>
  putImage(descriptor: SkillImageAsset, bytes: Uint8Array): Promise<{ stored: boolean }>
  getImage(digest: string): Promise<{ descriptor: SkillImageAsset; bytes: Uint8Array } | null>
  getImageStream?(digest: string): Promise<{
    descriptor: SkillImageAsset
    body: ReadableStream<Uint8Array> | Uint8Array
  } | null>
}

export interface SkillRegistryMaintenanceStore extends SkillRegistryStore {
  listSnapshots(registryID: string): Promise<SkillRegistryCatalog[]>
  deleteSnapshot(registryID: string, revision: string): Promise<void>
  listArtifactDigests(): Promise<string[]>
  deleteArtifact(digest: string): Promise<void>
  listImageDigests(): Promise<string[]>
  deleteImage(digest: string): Promise<void>
}
