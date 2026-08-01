import type { PluginReleaseStore } from '../storage/contracts'
import { sha256 } from '#registry/digest'
import {
  parsePluginRelease,
  pluginReleaseRevision,
  type PluginReleaseCandidate,
} from '../release'
import {
  assertPluginReleaseCandidate,
  type PluginReleaseLock,
} from '../release-lock'

export interface PluginReleasePublishResult {
  plugin: string
  revision?: string
  skipped?: 'unchanged' | 'recovered' | 'disabled'
}

export class PluginReleasePublisher {
  constructor(private readonly store: PluginReleaseStore) {}

  async publish(
    candidate: PluginReleaseCandidate,
    lock?: PluginReleaseLock,
  ): Promise<PluginReleasePublishResult> {
    if (!lock) throw new Error(`${candidate.plugin_id}: release.lock.json is required`)
    const release = parsePluginRelease(candidate.releaseBytes, candidate.plugin_id)
    const revision = await pluginReleaseRevision(candidate.releaseBytes)
    assertPluginReleaseCandidate(candidate.plugin_id, lock, revision)
    if (candidate.revision !== revision) {
      throw new Error(`${candidate.plugin_id}: candidate revision does not match its release bytes`)
    }
    const descriptor = release.artifact
    const packagedDescriptor = candidate.artifact.descriptor
    if (descriptor.format !== packagedDescriptor.format
      || descriptor.digest !== packagedDescriptor.digest
      || descriptor.size !== packagedDescriptor.size
      || descriptor.content_type !== packagedDescriptor.content_type) {
      throw new Error(`${candidate.plugin_id}: Plugin release does not describe its packaged Artifact`)
    }
    if (descriptor.size !== candidate.artifact.bytes.length
      || descriptor.digest !== await sha256(candidate.artifact.bytes)) {
      throw new Error(`${candidate.plugin_id}: Plugin release Artifact does not match its content`)
    }

    const stateRead = await this.store.getStateWithVersion(candidate.plugin_id)
    const previous = stateRead.state
    const expectedVersion = stateRead.versioning === 'conditional' ? stateRead.version : undefined
    if (previous?.current_release) {
      const current = await this.store.getRelease(candidate.plugin_id, previous.current_release)
      if (!current) throw new Error(`Current Plugin release is missing: ${candidate.plugin_id}/${previous.current_release}`)
    }
    await this.store.putArtifact(descriptor, candidate.artifact.bytes)
    if (previous?.enabled && previous.current_release === revision) {
      return { plugin: candidate.plugin_id, revision, skipped: 'unchanged' }
    }

    const existing = await this.store.getRelease(candidate.plugin_id, revision)
    const publishedRevision = await this.store.publishRelease(
      candidate.releaseBytes,
      candidate.plugin_id,
      { expectedVersion },
    )
    if (publishedRevision !== lock.release_revision) {
      throw new Error(`${candidate.plugin_id}: Plugin Store published an unapproved release revision`)
    }
    return {
      plugin: candidate.plugin_id,
      revision,
      ...(existing ? { skipped: 'recovered' as const } : {}),
    }
  }

  async disable(pluginID: string): Promise<PluginReleasePublishResult> {
    const stateRead = await this.store.getStateWithVersion(pluginID)
    const state = stateRead.state
    if (!state || !state.enabled) return { plugin: pluginID, skipped: 'disabled' }
    await this.store.putState(
      { ...state, enabled: false },
      stateRead.versioning === 'conditional' ? stateRead.version : undefined,
    )
    return { plugin: pluginID, revision: state.current_release, skipped: 'disabled' }
  }
}
