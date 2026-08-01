import type { SkillRegistryDefinition } from '../types'
import type { SkillRegistryStore } from '../storage/contracts'
import { assertReleaseCandidate, type RegistryReleaseLock } from './release-lock'
import {
  buildSkillRegistryCandidate,
  type SkillRegistryCandidate,
  type SkillRegistryBuildProgress,
} from './candidate'

export interface SkillRegistryPublishResult {
  registry: string
  revision?: string
  skills?: number
  diagnostics?: number
  skipped?: 'disabled' | 'unchanged' | 'recovered'
}

export type SkillRegistryPublishProgress =
  | SkillRegistryBuildProgress
  | { type: 'skill'; registry: string; index: number; total: number; package_id: string; skill_id: string; uploaded: boolean }
  | { type: 'publishing'; registry: string; revision: string }

function sameDefinition(left: SkillRegistryDefinition, right: SkillRegistryDefinition) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function requireReleaseLock(
  definition: SkillRegistryDefinition,
  lock: RegistryReleaseLock | undefined,
) {
  if (!lock) throw new Error(`${definition.id}: release.lock.json is required`)
  return lock
}

export class SkillRegistryPublisher {
  constructor(
    private readonly store: SkillRegistryStore,
    private readonly projectRoot: string,
    private readonly onProgress: (progress: SkillRegistryPublishProgress) => void = () => {},
  ) {}

  private async publishCandidateAssets(candidate: SkillRegistryCandidate) {
    const uploadedArtifacts = new Map<string, boolean>()
    const uploadedImages = new Map<string, boolean>()
    for (const [index, skill] of candidate.skills.entries()) {
      let uploaded = uploadedArtifacts.get(skill.artifact.digest)
      if (uploaded == null) {
        const artifact = candidate.artifacts.get(skill.artifact.digest)
        if (!artifact) throw new Error(`Candidate Artifact is missing: ${skill.artifact.digest}`)
        uploaded = (await this.store.putArtifact(artifact.descriptor, artifact.bytes)).stored
        uploadedArtifacts.set(skill.artifact.digest, uploaded)
      }
      for (const descriptor of [skill.icon?.card, skill.icon?.detail, skill.icon?.dark]) {
        if (!descriptor || uploadedImages.has(descriptor.digest)) continue
        const image = candidate.images.get(descriptor.digest)
        if (!image) throw new Error(`Candidate Skill icon is missing: ${descriptor.digest}`)
        const stored = (await this.store.putImage(image.descriptor, image.bytes)).stored
        uploadedImages.set(descriptor.digest, stored)
        uploaded ||= stored
      }
      this.onProgress({
        type: 'skill',
        registry: candidate.definition.id,
        index: index + 1,
        total: candidate.skills.length,
        package_id: skill.package_id,
        skill_id: skill.skill_id,
        uploaded,
      })
    }
  }

  async publish(
    definition: SkillRegistryDefinition,
    releaseLock?: RegistryReleaseLock,
  ): Promise<SkillRegistryPublishResult> {
    const stateRead = await this.store.getStateWithVersion(definition.id)
    const previousState = stateRead.state
    const stateVersion = stateRead.versioning === 'conditional'
      ? stateRead.version
      : undefined
    const current = previousState?.current_snapshot
      ? await this.store.getSnapshot(definition.id, previousState.current_snapshot)
      : null
    if (previousState?.current_snapshot && !current) {
      throw new Error(`Current Registry snapshot is missing: ${definition.id}/${previousState.current_snapshot}`)
    }

    if (!definition.enabled) {
      await this.store.putState({
        schema_version: '1',
        definition,
        current_snapshot: previousState?.current_snapshot,
        current_summary: previousState?.current_summary,
      }, stateVersion)
      return { registry: definition.id, skipped: 'disabled' }
    }

    const lock = requireReleaseLock(definition, releaseLock)
    const candidate = await buildSkillRegistryCandidate(definition, this.projectRoot, this.onProgress)
    assertReleaseCandidate(definition, lock, candidate.revision)
    await this.publishCandidateAssets(candidate)
    if (previousState?.current_snapshot === candidate.revision) {
      if (!previousState || !sameDefinition(previousState.definition, definition)) {
        await this.store.putState({
          ...previousState,
          schema_version: '1',
          definition,
        }, stateVersion)
      }
      return {
        registry: definition.id,
        revision: candidate.revision,
        skills: candidate.skills.length,
        diagnostics: candidate.diagnostics.length,
        skipped: 'unchanged',
      }
    }

    const previouslyPublished = await this.store.getSnapshot(definition.id, candidate.revision)
    if (previouslyPublished) {
      await this.store.publishSnapshot(candidate.snapshotBytes, definition, { expectedVersion: stateVersion })
      return {
        registry: definition.id,
        revision: candidate.revision,
        skills: previouslyPublished.skills.length,
        diagnostics: previouslyPublished.diagnostics.length,
        skipped: 'recovered',
      }
    }

    this.onProgress({ type: 'publishing', registry: definition.id, revision: candidate.revision })
    await this.store.publishSnapshot(candidate.snapshotBytes, definition, { expectedVersion: stateVersion })
    return {
      registry: definition.id,
      revision: candidate.revision,
      skills: candidate.skills.length,
      diagnostics: candidate.diagnostics.length,
    }
  }
}
