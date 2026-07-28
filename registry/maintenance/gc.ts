import type { SkillRegistryCatalog, SkillRegistryDefinition } from '../types'
import type { SkillRegistryMaintenanceStore } from '../storage/contracts'

function snapshotTime(snapshot: SkillRegistryCatalog) {
  const value = Date.parse(snapshot.synced_at)
  if (!Number.isFinite(value)) {
    throw new Error(`Snapshot has invalid synced_at: ${snapshot.registry.id}/${snapshot.revision}`)
  }
  return value
}

export interface SkillRegistryGarbageCollectionResult {
  applied: boolean
  registries: Array<{
    registry_id: string
    retention?: number
    current_snapshot?: string
    retained_snapshots: string[]
    deleted_snapshots: string[]
    protected_reason?: 'unmanaged_registry' | 'missing_current'
  }>
  artifacts: {
    stored: number
    referenced: number
    deleted: string[]
  }
  images: {
    stored: number
    referenced: number
    deleted: string[]
  }
}

export async function garbageCollectSkillRegistries(input: {
  store: SkillRegistryMaintenanceStore
  definitions: SkillRegistryDefinition[]
  apply?: boolean
  assertWriterActive?: () => void | Promise<void>
}): Promise<SkillRegistryGarbageCollectionResult> {
  if (input.apply && !input.assertWriterActive) {
    throw new Error('Applied Registry garbage collection requires a writer lock guard')
  }
  const assertWriterActive = input.assertWriterActive ?? (() => {})
  const definitions = new Map(input.definitions.map((definition) => [definition.id, definition]))
  const storedIDs = await input.store.listRegistryIDs()
  const registryIDs = [...new Set([...storedIDs, ...definitions.keys()])].sort()
  const referencedArtifacts = new Set<string>()
  const referencedImages = new Set<string>()
  const currentRevisions = new Map<string, string | undefined>()
  const registries: SkillRegistryGarbageCollectionResult['registries'] = []

  for (const registryID of registryIDs) {
    await assertWriterActive()
    const [snapshots, state] = await Promise.all([
      input.store.listSnapshots(registryID), input.store.getState(registryID),
    ])
    const current = state?.current_snapshot
      ? await input.store.getSnapshot(registryID, state.current_snapshot)
      : null
    const definition = definitions.get(registryID)
    const sorted = [...snapshots].sort((left, right) => {
      return snapshotTime(right) - snapshotTime(left) || right.revision.localeCompare(left.revision)
    })
    currentRevisions.set(registryID, current?.revision)

    let retained: SkillRegistryCatalog[]
    let deleted: SkillRegistryCatalog[]
    let protectedReason: 'unmanaged_registry' | 'missing_current' | undefined
    if (!definition) {
      retained = sorted
      deleted = []
      protectedReason = 'unmanaged_registry'
    } else if (sorted.length && !current) {
      retained = sorted
      deleted = []
      protectedReason = 'missing_current'
    } else {
      const retainedRevisions = new Set(sorted.slice(0, definition.retention.snapshots).map((item) => item.revision))
      if (current) retainedRevisions.add(current.revision)
      if (current && !sorted.some((snapshot) => snapshot.revision === current.revision)) {
        throw new Error(`Current Snapshot is missing from revision listing: ${registryID}/${current.revision}`)
      }
      retained = sorted.filter((snapshot) => retainedRevisions.has(snapshot.revision))
      deleted = sorted.filter((snapshot) => !retainedRevisions.has(snapshot.revision))
    }
    for (const snapshot of retained) {
      for (const skill of snapshot.skills) {
        referencedArtifacts.add(skill.artifact.digest)
        for (const image of [skill.icon?.card, skill.icon?.detail, skill.icon?.dark]) {
          if (image) referencedImages.add(image.digest)
        }
      }
    }
    registries.push({
      registry_id: registryID,
      retention: definition?.retention.snapshots,
      current_snapshot: current?.revision,
      retained_snapshots: retained.map((snapshot) => snapshot.revision),
      deleted_snapshots: deleted.map((snapshot) => snapshot.revision),
      protected_reason: protectedReason,
    })
  }

  const [storedArtifacts, storedImages] = await Promise.all([
    input.store.listArtifactDigests(), input.store.listImageDigests(),
  ])
  const deletedArtifacts = storedArtifacts.filter((digest) => !referencedArtifacts.has(digest))
  const deletedImages = storedImages.filter((digest) => !referencedImages.has(digest))
  if (input.apply) {
    for (const registry of registries) {
      for (const revision of registry.deleted_snapshots) {
        await assertWriterActive()
        await input.store.deleteSnapshot(registry.registry_id, revision)
      }
    }
    for (const [registryID, expectedRevision] of currentRevisions) {
      await assertWriterActive()
      const liveState = await input.store.getState(registryID)
      if (liveState?.current_snapshot !== expectedRevision) {
        throw new Error(`Current Snapshot changed during garbage collection: ${registryID}`)
      }
    }
    for (const digest of deletedArtifacts) {
      await assertWriterActive()
      await input.store.deleteArtifact(digest)
    }
    for (const digest of deletedImages) {
      await assertWriterActive()
      await input.store.deleteImage(digest)
    }
  }

  return {
    applied: input.apply === true,
    registries,
    artifacts: {
      stored: storedArtifacts.length,
      referenced: referencedArtifacts.size,
      deleted: deletedArtifacts,
    },
    images: {
      stored: storedImages.length,
      referenced: referencedImages.size,
      deleted: deletedImages,
    },
  }
}
