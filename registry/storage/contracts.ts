import type {
  SkillArtifactBlob,
  SkillArtifactDescriptor,
  SkillImageAsset,
  SkillRegistrySnapshot,
  SkillRegistryState,
} from '../types'

export interface BlobBackend {
  get(key: string): Promise<Uint8Array | null>
  put(key: string, value: Uint8Array): Promise<void>
  list(prefix: string): Promise<string[]>
  listPrefixes(prefix: string): Promise<string[]>
  getStream?(key: string): Promise<{ body: ReadableStream<Uint8Array>; size?: number } | null>
  // Paired with putConditional: a backend implementing one should implement both,
  // so a caller can learn a key's current version and later write conditioned on it.
  getWithVersion?(key: string): Promise<{ value: Uint8Array; version: string } | null>
  putConditional?(key: string, value: Uint8Array, expectedVersion: string | null): Promise<string | null>
}

export interface SkillRegistryStore {
  listRegistryIDs(): Promise<string[]>
  getState(registryID: string): Promise<SkillRegistryState | null>
  getStateWithVersion(registryID: string): Promise<{ state: SkillRegistryState | null; version: string | null }>
  putState(state: SkillRegistryState, expectedVersion?: string | null): Promise<void>
  getSnapshot(registryID: string, revision: string): Promise<SkillRegistrySnapshot | null>
  publishSnapshot(
    bytes: Uint8Array,
    definition: SkillRegistryState['definition'],
    options?: { expectedVersion?: string | null; publishedAt?: string },
  ): Promise<string>
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
