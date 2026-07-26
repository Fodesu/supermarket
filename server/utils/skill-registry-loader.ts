import type {
  CatalogSkill,
  SkillArtifactDescriptor,
  SkillRegistryCatalog,
  SkillRegistrySummary,
} from '../types/skill-registry'
import type { SkillCatalogSearchOptions } from './skill-catalog-search'
import { searchCatalogSkills, summarizeSkillCategories } from './skill-catalog-search'
import { BlobSkillRegistryStore, R2BlobBackend, type SkillRegistryStore } from './skill-registry-store'

let localStore: Promise<SkillRegistryStore> | undefined
const r2Stores = new WeakMap<object, SkillRegistryStore>()

export async function getRuntimeSkillRegistryStore(event?: any): Promise<SkillRegistryStore> {
  const cloudflare = event?.req?.runtime?.cloudflare
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
  localStore ??= import('./local-skill-registry-store').then(({ LocalSkillRegistryStore }) => new LocalSkillRegistryStore())
  return localStore
}

export async function getEnabledSkillRegistryCatalogs(
  store: SkillRegistryStore,
  registryID?: string,
): Promise<SkillRegistryCatalog[]> {
  const ids = registryID ? [registryID] : await store.listRegistryIDs()
  const values = await Promise.all(ids.map(async (id) => {
    const [catalog, definition] = await Promise.all([store.getCatalog(id), store.getDefinition(id)])
    if (!catalog || !(definition?.enabled ?? catalog.registry.enabled)) return null
    return catalog
  }))
  return values.filter((catalog): catalog is SkillRegistryCatalog => catalog !== null)
}

function artifactResponse(descriptor: SkillArtifactDescriptor) {
  return { ...descriptor, download_url: `/api/artifacts/${descriptor.digest}/download` }
}

function iconResponse(icon: CatalogSkill['icon']) {
  if (!icon) return undefined
  const image = (value: typeof icon.card) => value && ({ ...value, download_url: `/api/skill-images/${value.digest}` })
  return { ...icon, card: image(icon.card), detail: image(icon.detail), dark: image(icon.dark) }
}

export function publicCatalogSkill(skill: CatalogSkill) {
  const { registry_priority: _priority, ...value } = skill
  return { ...value, icon: iconResponse(skill.icon), artifact: artifactResponse(skill.artifact) }
}

export async function getCatalogSkills(event: any, options: SkillCatalogSearchOptions = {}) {
  const store = await getRuntimeSkillRegistryStore(event)
  const skills = (await getEnabledSkillRegistryCatalogs(store, options.registry)).flatMap((catalog) => catalog.skills)
  const result = searchCatalogSkills(skills, options)
  return { ...result, data: result.data.map(publicCatalogSkill) }
}

export async function getCatalogSkill(event: any, registryID: string, packageID: string, skillID: string) {
  const [catalog] = await getEnabledSkillRegistryCatalogs(await getRuntimeSkillRegistryStore(event), registryID)
  return catalog?.skills.find((skill) => skill.package_id === packageID && skill.skill_id === skillID)
}

export async function getSkillRegistrySummaries(event: any): Promise<SkillRegistrySummary[]> {
  const store = await getRuntimeSkillRegistryStore(event)
  const ids = await store.listRegistryIDs()
  const summaries = await Promise.all(ids.map((id) => getSkillRegistrySummary(store, id)))
  return summaries.filter((summary): summary is SkillRegistrySummary => summary !== null)
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
}

async function getSkillRegistrySummary(store: SkillRegistryStore, registryID: string): Promise<SkillRegistrySummary | null> {
  const [catalog, definition, status] = await Promise.all([
    store.getCatalog(registryID), store.getDefinition(registryID), store.getStatus(registryID),
  ])
  const registry = definition ?? catalog?.registry
  if (!registry) return null
  const lastSuccess = status?.last_success_at ? Date.parse(status.last_success_at) : Number.NaN
  const nextRefreshAt = Number.isFinite(lastSuccess)
    ? new Date(lastSuccess + registry.refresh_interval_seconds * 1000).toISOString()
    : undefined
  return {
    id: registry.id, name: registry.name, enabled: registry.enabled, priority: registry.priority,
    adapter: registry.adapter, revision: catalog?.revision, synced_at: catalog?.synced_at,
    skill_count: catalog?.skills.length ?? 0,
    package_count: new Set(catalog?.skills.map((skill) => skill.package_id) ?? []).size,
    category_count: summarizeSkillCategories(catalog?.skills ?? []).length,
    skipped_package_count: new Set(catalog?.diagnostics.map((item) => item.package_id).filter(Boolean) ?? []).size,
    refresh_interval_seconds: registry.refresh_interval_seconds, next_refresh_at: nextRefreshAt,
    status: status?.state ?? (catalog?.skills.length ? 'ready' : 'empty'), last_error: status?.last_error,
  }
}

export async function getSkillRegistryDetails(event: any, registryID: string) {
  const store = await getRuntimeSkillRegistryStore(event)
  const summary = await getSkillRegistrySummary(store, registryID)
  if (!summary) return undefined
  const [catalog, definition, status] = await Promise.all([
    store.getCatalog(registryID), store.getDefinition(registryID), store.getStatus(registryID),
  ])
  return { ...summary, definition, status, source_revision: catalog?.source_revision, diagnostics: catalog?.diagnostics ?? [] }
}

export async function getSkillCategories(event: any, registryID?: string) {
  const store = await getRuntimeSkillRegistryStore(event)
  return summarizeSkillCategories((await getEnabledSkillRegistryCatalogs(store, registryID)).flatMap((catalog) => catalog.skills))
}

export async function getRegistrySkillTags(event: any) {
  const tags = new Set<string>()
  const store = await getRuntimeSkillRegistryStore(event)
  for (const skill of (await getEnabledSkillRegistryCatalogs(store)).flatMap((catalog) => catalog.skills)) {
    for (const tag of skill.tags) tags.add(tag)
  }
  return [...tags].sort()
}
