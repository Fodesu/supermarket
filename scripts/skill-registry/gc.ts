import type { SkillRegistryCatalog, SkillRegistryDefinition } from '../../server/types/skill-registry'
import type { SkillRegistryMaintenanceStore } from '../../server/utils/skill-registry-store'

function catalogTime(catalog: SkillRegistryCatalog) {
  const value = Date.parse(catalog.synced_at)
  if (!Number.isFinite(value)) throw new Error(`Catalog has invalid synced_at: ${catalog.registry.id}/${catalog.revision}`)
  return value
}

export interface SkillRegistryGarbageCollectionResult {
  applied: boolean
  registries: Array<{
    registry_id: string
    retention?: number
    current_snapshot?: string
    retained_revisions: string[]
    deleted_revisions: string[]
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
    const [catalogs, state] = await Promise.all([
      input.store.listCatalogRevisions(registryID), input.store.getState(registryID),
    ])
    const current = state?.current_snapshot
      ? await input.store.getSnapshot(registryID, state.current_snapshot)
      : null
    const definition = definitions.get(registryID)
    const sorted = [...catalogs].sort((left, right) => {
      return catalogTime(right) - catalogTime(left) || right.revision.localeCompare(left.revision)
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
      const retainedRevisions = new Set(sorted.slice(0, definition.retention.catalog_revisions).map((item) => item.revision))
      if (current) retainedRevisions.add(current.revision)
      if (current && !sorted.some((catalog) => catalog.revision === current.revision)) {
        throw new Error(`Current Catalog is missing from revision listing: ${registryID}/${current.revision}`)
      }
      retained = sorted.filter((catalog) => retainedRevisions.has(catalog.revision))
      deleted = sorted.filter((catalog) => !retainedRevisions.has(catalog.revision))
    }
    for (const catalog of retained) {
      for (const skill of catalog.skills) {
        referencedArtifacts.add(skill.artifact.digest)
        for (const image of [skill.icon?.card, skill.icon?.detail, skill.icon?.dark]) {
          if (image) referencedImages.add(image.digest)
        }
      }
    }
    registries.push({
      registry_id: registryID,
      retention: definition?.retention.catalog_revisions,
      current_snapshot: current?.revision,
      retained_revisions: retained.map((catalog) => catalog.revision),
      deleted_revisions: deleted.map((catalog) => catalog.revision),
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
      for (const revision of registry.deleted_revisions) {
        await assertWriterActive()
        await input.store.deleteCatalogRevision(registry.registry_id, revision)
      }
    }
    for (const [registryID, expectedRevision] of currentRevisions) {
      await assertWriterActive()
      const liveState = await input.store.getState(registryID)
      if (liveState?.current_snapshot !== expectedRevision) {
        throw new Error(`Current Catalog changed during garbage collection: ${registryID}`)
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
