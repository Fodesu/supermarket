import type {
  PluginArtifactDescriptor,
  PluginRelease,
  PluginReleaseState,
} from '../types'
import type { VersionedStateRead } from '#registry/storage/contracts'

export type PluginReleaseStateRead = VersionedStateRead<PluginReleaseState>

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
  getArtifactStream(digest: string): Promise<{
    descriptor: PluginArtifactDescriptor
    body: ReadableStream<Uint8Array>
  } | null>
}
