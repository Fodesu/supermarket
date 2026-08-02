import { R2BlobBackend } from '#registry/storage/r2'
import { BlobPluginReleaseStore } from '#plugin/storage/blob'
import type { PluginReleaseStore } from '#plugin/storage/contracts'
import type {
  PluginRelease,
  PluginReleaseState,
  PublishedPluginEntry,
} from '#plugin/types'
import { createRuntimeStoreResolver, type RuntimeStoreEvent } from './runtime-store'

type RuntimeEvent = RuntimeStoreEvent

interface CurrentPluginRelease {
  state: PluginReleaseState
  release: PluginRelease
}

const releaseCaches = new WeakMap<object, Map<string, PluginRelease>>()
const maxCachedReleases = 64

function releaseCache(store: PluginReleaseStore) {
  let cache = releaseCaches.get(store)
  if (!cache) {
    cache = new Map()
    releaseCaches.set(store, cache)
  }
  return cache
}

export async function cachedRelease(store: PluginReleaseStore, pluginID: string, revision: string) {
  const cache = releaseCache(store)
  const key = `${pluginID}/${revision}`
  const current = cache.get(key)
  if (current) {
    cache.delete(key)
    cache.set(key, current)
    return current
  }
  const value = await store.getRelease(pluginID, revision)
  if (!value) return null
  cache.set(key, value)
  while (cache.size > maxCachedReleases) cache.delete(cache.keys().next().value!)
  return value
}

export const getRuntimePluginReleaseStore = createRuntimeStoreResolver<PluginReleaseStore>({
  remote: (bucket) => new BlobPluginReleaseStore(new R2BlobBackend(bucket)),
  local: () => import('#plugin/storage/local')
    .then(({ LocalPluginReleaseStore }) => new LocalPluginReleaseStore()),
})

async function currentPluginRelease(
  store: PluginReleaseStore,
  pluginID: string,
): Promise<CurrentPluginRelease | null> {
  const state = await store.getState(pluginID)
  if (!state?.enabled || !state.current_release || !state.current_summary) return null
  const release = await cachedRelease(store, pluginID, state.current_release)
  if (!release) throw new Error(`Current Plugin release is missing: ${pluginID}/${state.current_release}`)
  return { state, release }
}

function publicArtifact<T extends { digest: string }>(artifact: T, kind: 'plugin' | 'skill') {
  return { ...artifact, download_url: `/api/artifacts/${kind}/${artifact.digest}` }
}

function publicPlugin(current: CurrentPluginRelease): PublishedPluginEntry {
  const revision = current.state.current_release!
  const publishedAt = current.state.current_summary!.published_at
  return {
    ...current.release.plugin,
    release: {
      revision,
      published_at: publishedAt,
      artifact: publicArtifact(current.release.artifact, 'plugin'),
      skills: current.release.skills.map((skill) => ({
        ...skill,
        artifact: publicArtifact(skill.artifact, 'skill'),
      })),
    },
  }
}

async function allCurrentPlugins(store: PluginReleaseStore) {
  const values = await Promise.all((await store.listPluginIDs())
    .map((pluginID) => currentPluginRelease(store, pluginID)))
  return values.filter((value): value is CurrentPluginRelease => value !== null)
}

export async function getAllPlugins(event: RuntimeEvent, options?: {
  q?: string
  tag?: string
  page?: number
  limit?: number
}) {
  const all = (await allCurrentPlugins(await getRuntimePluginReleaseStore(event))).map(publicPlugin)
  let filtered = all

  if (options?.tag) {
    const tag = options.tag.toLowerCase()
    filtered = filtered.filter((plugin) => plugin.tags?.some((item) => item.toLowerCase() === tag))
  }
  if (options?.q) {
    const q = options.q.toLowerCase()
    filtered = filtered.filter(
      (plugin) => plugin.name.toLowerCase().includes(q)
        || plugin.description.toLowerCase().includes(q)
        || plugin.tags?.some((tag) => tag.toLowerCase().includes(q))
        || plugin.capabilities?.some((capability) => capability.toLowerCase().includes(q)),
    )
  }

  filtered.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
  const page = options?.page ?? 1
  const limit = options?.limit ?? 20
  const start = (page - 1) * limit
  return { total: filtered.length, page, limit, data: filtered.slice(start, start + limit) }
}

export async function getPluginById(event: RuntimeEvent, pluginID: string) {
  const current = await currentPluginRelease(await getRuntimePluginReleaseStore(event), pluginID)
  return current ? publicPlugin(current) : undefined
}

export async function getPluginReleaseBytes(
  event: RuntimeEvent,
  pluginID: string,
  revision: string,
) {
  return getRuntimePluginReleaseStore(event)
    .then((store) => store.getReleaseBytes(pluginID, revision))
}

export async function getPluginDownloadDescriptor(event: RuntimeEvent, pluginID: string) {
  const store = await getRuntimePluginReleaseStore(event)
  const current = await currentPluginRelease(store, pluginID)
  if (!current) return undefined
  return {
    descriptor: current.release.artifact,
    revision: current.state.current_release!,
  }
}

export async function getAllPluginTags(event: RuntimeEvent): Promise<string[]> {
  const tags = new Set<string>()
  for (const current of await allCurrentPlugins(await getRuntimePluginReleaseStore(event))) {
    for (const tag of current.release.plugin.tags ?? []) tags.add(tag)
  }
  return [...tags].sort()
}
