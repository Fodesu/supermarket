import type {
  CatalogSkill,
  SkillArtifactDescriptor,
  SkillRegistryCatalog,
  SkillRegistrySummary,
} from '#registry/types'
import type { SkillCatalogSearchOptions } from '#registry/catalog'
import { searchCatalogSkills, summarizeSkillCategories } from '#registry/catalog'
import { R2BlobBackend } from '#registry/storage/r2'
import { BlobSkillRegistryStore } from '#registry/storage/blob'
import type { SkillRegistryStore } from '#registry/storage/contracts'
import { RegistrySnapshotCache } from './registry-snapshot-cache'

let localStore: Promise<SkillRegistryStore> | undefined
const r2Stores = new WeakMap<object, SkillRegistryStore>()
const snapshotCaches = new WeakMap<object, RegistrySnapshotCache>()

interface RuntimeEvent {
  req: { runtime?: unknown }
}

function snapshotCache(store: SkillRegistryStore) {
  let cache = snapshotCaches.get(store)
  if (!cache) {
    cache = new RegistrySnapshotCache()
    snapshotCaches.set(store, cache)
  }
  return cache
}

function cachedSnapshot(store: SkillRegistryStore, registryID: string, revision: string) {
  return snapshotCache(store).get(store, registryID, revision)
}

export async function getRuntimeSkillRegistryStore(event?: RuntimeEvent): Promise<SkillRegistryStore> {
  const runtime = event?.req.runtime as { cloudflare?: { env?: Partial<ApiEnv> } } | undefined
  const cloudflare = runtime?.cloudflare
  if (cloudflare) {
    const bucket = cloudflare.env?.SKILL_REGISTRY_BUCKET
    if (!bucket || typeof bucket !== 'object') {
      throw new Error('Cloudflare runtime is missing the SKILL_REGISTRY_BUCKET R2 binding')
    }
    let store = r2Stores.get(bucket)
    if (!store) {
      store = new BlobSkillRegistryStore(new R2BlobBackend(bucket))
      r2Stores.set(bucket, store)
    }
    return store
  }
  localStore ??= import('#registry/storage/local').then(({ LocalSkillRegistryStore }) => new LocalSkillRegistryStore())
  return localStore
}

export async function getEnabledSkillRegistryCatalogs(
  store: SkillRegistryStore,
  registryID?: string,
): Promise<SkillRegistryCatalog[]> {
  const ids = registryID ? [registryID] : await store.listRegistryIDs()
  const values: SkillRegistryCatalog[] = []
  const cache = snapshotCache(store)
  for (const id of ids) {
    const state = await store.getState(id)
    if (!state?.definition.enabled || !state.current_snapshot) continue
    const catalog = await cachedSnapshot(store, id, state.current_snapshot)
    if (!catalog) throw new Error(`Current Registry snapshot is missing: ${id}/${state.current_snapshot}`)
    values.push(catalog)
    cache.assertRequestBudget(values)
  }
  return values
}

function artifactResponse(descriptor: SkillArtifactDescriptor) {
  return { ...descriptor, download_url: `/api/artifacts/skill/${descriptor.digest}` }
}

export function publicCatalogSkill(skill: CatalogSkill) {
  const { registry_priority: _priority, ...value } = skill
  return { ...value, artifact: artifactResponse(skill.artifact) }
}

export async function getCatalogSkills(event: RuntimeEvent, options: SkillCatalogSearchOptions = {}) {
  const store = await getRuntimeSkillRegistryStore(event)
  const skills = (await getEnabledSkillRegistryCatalogs(store, options.registry)).flatMap((catalog) => catalog.skills)
  const result = searchCatalogSkills(skills, options)
  return { ...result, data: result.data.map(publicCatalogSkill) }
}

export async function getCatalogSkill(event: RuntimeEvent, registryID: string, packageID: string, skillID: string) {
  const [catalog] = await getEnabledSkillRegistryCatalogs(await getRuntimeSkillRegistryStore(event), registryID)
  return catalog?.skills.find((skill) => skill.package_id === packageID && skill.skill_id === skillID)
}

export async function getSkillRegistrySummaries(event: RuntimeEvent): Promise<SkillRegistrySummary[]> {
  return getSkillRegistrySummariesForStore(await getRuntimeSkillRegistryStore(event))
}

export async function getSkillRegistrySummariesForStore(store: SkillRegistryStore): Promise<SkillRegistrySummary[]> {
  const ids = await store.listRegistryIDs()
  const summaries: SkillRegistrySummary[] = []
  for (const id of ids) {
    const summary = await getSkillRegistrySummary(store, id)
    if (summary) summaries.push(summary)
  }
  return summaries.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
}

async function getSkillRegistrySummary(
  store: SkillRegistryStore,
  registryID: string,
): Promise<SkillRegistrySummary | null> {
  const state = await store.getState(registryID)
  if (!state) return null
  const registry = state.definition
  const status = state.status
  const current = state.current_summary
  const lastSuccess = status?.last_success_at ? Date.parse(status.last_success_at) : Number.NaN
  const nextRefreshAt = Number.isFinite(lastSuccess)
    ? new Date(lastSuccess + registry.refresh_interval_seconds * 1000).toISOString()
    : undefined
  return {
    id: registry.id, name: registry.name, enabled: registry.enabled, priority: registry.priority,
    adapter: registry.adapter.type, revision: current?.revision, synced_at: current?.synced_at,
    skill_count: current?.skill_count ?? 0,
    package_count: current?.package_count ?? 0,
    category_count: current?.category_count ?? 0,
    skipped_package_count: current?.skipped_package_count ?? 0,
    refresh_interval_seconds: registry.refresh_interval_seconds, next_refresh_at: nextRefreshAt,
    status: status.state, last_error: status.last_error,
  }
}

export async function getSkillRegistryDetails(event: RuntimeEvent, registryID: string) {
  const store = await getRuntimeSkillRegistryStore(event)
  const summary = await getSkillRegistrySummary(store, registryID)
  if (!summary) return undefined
  const state = await store.getState(registryID)
  if (!state) return undefined
  const catalog = state.current_snapshot ? await cachedSnapshot(store, registryID, state.current_snapshot) : null
  return { ...summary, definition: state.definition, status: state.status, source_revision: catalog?.source_revision, diagnostics: catalog?.diagnostics ?? [] }
}

export async function getSkillCategories(event: RuntimeEvent, registryID?: string) {
  const store = await getRuntimeSkillRegistryStore(event)
  return summarizeSkillCategories((await getEnabledSkillRegistryCatalogs(store, registryID)).flatMap((catalog) => catalog.skills))
}

export async function getRegistrySkillTags(event: RuntimeEvent) {
  const tags = new Set<string>()
  const store = await getRuntimeSkillRegistryStore(event)
  for (const skill of (await getEnabledSkillRegistryCatalogs(store)).flatMap((catalog) => catalog.skills)) {
    for (const tag of skill.tags) tags.add(tag)
  }
  return [...tags].sort()
}
