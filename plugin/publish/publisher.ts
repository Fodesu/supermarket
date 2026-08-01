import type { PluginReleaseStore } from '../storage/contracts'
import type { PluginReleaseCandidate } from '../release'
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
    assertPluginReleaseCandidate(candidate.plugin_id, lock, candidate.revision)
    const stateRead = await this.store.getStateWithVersion(candidate.plugin_id)
    const previous = stateRead.state
    const expectedVersion = stateRead.versioning === 'conditional' ? stateRead.version : undefined
    if (previous?.current_release) {
      const current = await this.store.getRelease(candidate.plugin_id, previous.current_release)
      if (!current) throw new Error(`Current Plugin release is missing: ${candidate.plugin_id}/${previous.current_release}`)
    }
    if (previous?.enabled && previous.current_release === candidate.revision) {
      return { plugin: candidate.plugin_id, revision: candidate.revision, skipped: 'unchanged' }
    }

    const existing = await this.store.getRelease(candidate.plugin_id, candidate.revision)
    await this.store.putArtifact(candidate.artifact.descriptor, candidate.artifact.bytes)
    await this.store.publishRelease(candidate.releaseBytes, candidate.plugin_id, { expectedVersion })
    return {
      plugin: candidate.plugin_id,
      revision: candidate.revision,
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
