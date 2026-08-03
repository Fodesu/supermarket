import type { PluginReleaseStore } from '../storage/contracts'
import type { SkillRegistryStore } from '#registry/storage/contracts'
import { assertSkillArtifactsAvailable } from '#registry/storage/availability'
import { serializePluginRelease, type PluginReleaseCandidate } from '../release'
import {
  assertPluginReleaseCandidate,
  type PluginReleaseLock,
} from '../release-lock'

export interface PluginReleasePublishResult {
  plugin: string
  revision?: string
  skipped?: 'unchanged' | 'disabled'
}

export class PluginReleasePublisher {
  constructor(
    private readonly store: PluginReleaseStore,
    private readonly skillStore?: SkillRegistryStore,
  ) {}

  async publish(
    candidate: PluginReleaseCandidate,
    lock?: PluginReleaseLock,
  ): Promise<PluginReleasePublishResult> {
    if (!lock) throw new Error(`${candidate.plugin_id}: release.lock.json is required`)
    assertPluginReleaseCandidate(candidate.plugin_id, lock, candidate.revision)
    const { artifact: descriptor, packages } = candidate.release
    const stateRead = await this.store.getStateWithVersion(candidate.plugin_id)
    const previous = stateRead.state
    const expectedVersion = stateRead.versioning === 'conditional' ? stateRead.version : undefined
    if (previous?.enabled && previous.current_release === candidate.revision) {
      return { plugin: candidate.plugin_id, revision: candidate.revision, skipped: 'unchanged' }
    }

    if (packages.length) {
      if (!this.skillStore) throw new Error(`${candidate.plugin_id}: Skill Registry Store is required`)
      const releases = await Promise.all(packages.map(async (reference) => {
        const release = await this.skillStore!.getPackageRelease(
          reference.registry_id,
          reference.package_id,
          reference.revision,
        )
        if (!release) {
          throw new Error(
            `${candidate.plugin_id}: referenced Package release is missing: `
            + `${reference.registry_id}/${reference.package_id}/${reference.revision}`,
          )
        }
        return release
      }))
      await assertSkillArtifactsAvailable(
        this.skillStore,
        releases.flatMap((release) => release.skills.map((skill) => skill.artifact)),
        `${candidate.plugin_id}: referenced Skill Artifact`,
      )
    }
    await this.store.putArtifact(descriptor, candidate.artifact_bytes)
    const releaseBytes = serializePluginRelease(candidate.release)
    await this.store.publishRelease(
      releaseBytes,
      candidate.plugin_id,
      { expectedVersion, expectedRevision: lock.release_revision },
    )
    return { plugin: candidate.plugin_id, revision: candidate.revision }
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
