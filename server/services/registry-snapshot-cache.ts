import type { SkillRegistryCatalog } from '#registry/types'
import type { SkillRegistryStore } from '#registry/storage/contracts'

interface SnapshotCacheEntry {
  value: Promise<SkillRegistryCatalog | null>
  bytes: number
}

const maxEntries = 32
const maxCachedBytes = 16 * 1024 * 1024
const maxRequestBytes = 24 * 1024 * 1024
const encoder = new TextEncoder()

export class RegistrySnapshotCache {
  private readonly entries = new Map<string, SnapshotCacheEntry>()
  private readonly sizes = new WeakMap<SkillRegistryCatalog, number>()

  get(store: SkillRegistryStore, registryID: string, revision: string) {
    const key = `${registryID}/${revision}`
    const existing = this.entries.get(key)
    if (existing) {
      this.entries.delete(key)
      this.entries.set(key, existing)
      return existing.value
    }

    const entry: SnapshotCacheEntry = { value: Promise.resolve(null), bytes: 0 }
    entry.value = store.getSnapshot(registryID, revision)
      .then((catalog) => {
        if (catalog) {
          entry.bytes = this.byteLength(catalog)
          if (this.entries.get(key) === entry) this.trim()
        }
        return catalog
      })
      .catch((error) => {
        if (this.entries.get(key) === entry) this.entries.delete(key)
        throw error
      })
    this.entries.set(key, entry)
    this.trim()
    return entry.value
  }

  assertRequestBudget(catalogs: SkillRegistryCatalog[]) {
    const bytes = catalogs.reduce((total, catalog) => total + this.byteLength(catalog), 0)
    if (bytes > maxRequestBytes) {
      throw new Error(`Enabled Registry Catalogs exceed the ${maxRequestBytes}-byte request budget`)
    }
  }

  private byteLength(catalog: SkillRegistryCatalog) {
    const cached = this.sizes.get(catalog)
    if (cached != null) return cached
    const bytes = encoder.encode(JSON.stringify(catalog)).length
    this.sizes.set(catalog, bytes)
    return bytes
  }

  private trim() {
    let bytes = [...this.entries.values()].reduce((total, entry) => total + entry.bytes, 0)
    while (this.entries.size > maxEntries || bytes > maxCachedBytes) {
      const oldest = this.entries.keys().next().value
      if (!oldest) break
      const entry = this.entries.get(oldest)
      this.entries.delete(oldest)
      bytes -= entry?.bytes ?? 0
    }
  }
}
