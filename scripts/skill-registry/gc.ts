import type { SkillRegistryCatalog, SkillRegistryDefinition } from '../../server/types/skill-registry'
import type { SkillRegistryStore } from '../../server/utils/skill-registry-store'

type MaintenanceMethod = 'listCatalogRevisions' | 'deleteCatalogRevision' | 'listArtifactDigests' | 'deleteArtifact'
type MaintenanceStore = SkillRegistryStore & Required<Pick<SkillRegistryStore, MaintenanceMethod>>

function requireMaintenanceStore(store: SkillRegistryStore): asserts store is MaintenanceStore {
  const methods: MaintenanceMethod[] = [
    'listCatalogRevisions', 'deleteCatalogRevision', 'listArtifactDigests', 'deleteArtifact',
  ]
  const missing = methods.filter((method) => typeof store[method] !== 'function')
  if (missing.length) throw new Error(`Registry Store does not support garbage collection: ${missing.join(', ')}`)
}

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
    current_revision?: string
    retained_revisions: string[]
    deleted_revisions: string[]
    protected_reason?: 'unmanaged_registry' | 'missing_current'
  }>
  artifacts: {
    stored: number
    referenced: number
    deleted: string[]
  }
}

export async function garbageCollectSkillRegistries(input: {
  store: SkillRegistryStore
  definitions: SkillRegistryDefinition[]
  apply?: boolean
  assertWriterLease?: () => void
}): Promise<SkillRegistryGarbageCollectionResult> {
  requireMaintenanceStore(input.store)
  if (input.apply && !input.assertWriterLease) {
    throw new Error('Applied Registry garbage collection requires a writer lock guard')
  }
  const assertWriterLease = input.assertWriterLease ?? (() => {})
  const definitions = new Map(input.definitions.map((definition) => [definition.id, definition]))
  const storedIDs = await input.store.listRegistryIDs()
  const registryIDs = [...new Set([...storedIDs, ...definitions.keys()])].sort()
  const referencedArtifacts = new Set<string>()
  const currentRevisions = new Map<string, string | undefined>()
  const registries: SkillRegistryGarbageCollectionResult['registries'] = []

  for (const registryID of registryIDs) {
    assertWriterLease()
    const [catalogs, current] = await Promise.all([
      input.store.listCatalogRevisions(registryID), input.store.getCatalog(registryID),
    ])
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
      for (const skill of catalog.skills) referencedArtifacts.add(skill.artifact.digest)
    }
    registries.push({
      registry_id: registryID,
      retention: definition?.retention.catalog_revisions,
      current_revision: current?.revision,
      retained_revisions: retained.map((catalog) => catalog.revision),
      deleted_revisions: deleted.map((catalog) => catalog.revision),
      protected_reason: protectedReason,
    })
  }

  const storedArtifacts = await input.store.listArtifactDigests()
  const deletedArtifacts = storedArtifacts.filter((digest) => !referencedArtifacts.has(digest))
  if (input.apply) {
    for (const registry of registries) {
      for (const revision of registry.deleted_revisions) {
        assertWriterLease()
        await input.store.deleteCatalogRevision(registry.registry_id, revision)
      }
    }
    for (const [registryID, expectedRevision] of currentRevisions) {
      assertWriterLease()
      const live = await input.store.getCatalog(registryID)
      if (live?.revision !== expectedRevision) {
        throw new Error(`Current Catalog changed during garbage collection: ${registryID}`)
      }
    }
    for (const digest of deletedArtifacts) {
      assertWriterLease()
      await input.store.deleteArtifact(digest)
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
  }
}
