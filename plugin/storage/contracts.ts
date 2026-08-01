import type {
  PluginArtifactDescriptor,
  PluginRelease,
  PluginReleaseState,
} from '../types'

export type PluginReleaseStateRead =
  | { state: PluginReleaseState | null; versioning: 'none' }
  | { state: PluginReleaseState | null; versioning: 'conditional'; version: string | null }

export interface PluginReleaseStore {
  listPluginIDs(): Promise<string[]>
  getState(pluginID: string): Promise<PluginReleaseState | null>
  getStateWithVersion(pluginID: string): Promise<PluginReleaseStateRead>
  putState(state: PluginReleaseState, expectedVersion?: string | null): Promise<void>
  getReleaseBytes(pluginID: string, revision: string): Promise<Uint8Array | null>
  getRelease(pluginID: string, revision: string): Promise<PluginRelease | null>
  publishRelease(
    bytes: Uint8Array,
    pluginID: string,
    options?: { expectedVersion?: string | null; expectedRevision?: string; publishedAt?: string },
  ): Promise<string>
  putArtifact(descriptor: PluginArtifactDescriptor, bytes: Uint8Array): Promise<{ stored: boolean }>
  getArtifact(digest: string): Promise<{ descriptor: PluginArtifactDescriptor; bytes: Uint8Array } | null>
  getArtifactStream?(digest: string): Promise<{
    descriptor: PluginArtifactDescriptor
    body: ReadableStream<Uint8Array> | Uint8Array
  } | null>
}
