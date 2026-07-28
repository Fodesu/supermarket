import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { SkillRegistryCatalog, SkillRegistryDefinition } from '#registry/types'
import { LocalSkillRegistryStore } from '#registry/storage/local'
import type { SkillRegistryStore } from '#registry/storage/contracts'
import { getEnabledSkillRegistryCatalogs, getRuntimeSkillRegistryStore } from './skill-registry'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

const definition: SkillRegistryDefinition = {
  schema_version: '1', id: 'example', name: 'Example', enabled: true, priority: 10,
  adapter: { type: 'skill_directory' }, source: { type: 'local', path: 'skills' }, refresh_interval_seconds: 43_200,
  retention: { snapshots: 30 },
}

describe('Skill Registry loader', () => {
  test('fails explicitly when a Cloudflare runtime has no R2 binding', async () => {
    await expect(getRuntimeSkillRegistryStore({ req: { runtime: { cloudflare: { env: {} } } } }))
      .rejects.toThrow('SKILL_REGISTRY_BUCKET')
  })

  test('stops serving a previous Catalog when its Registry is disabled', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skill-registry-loader-'))
    roots.push(root)
    const store = new LocalSkillRegistryStore(root)
    const revision = 'a'.repeat(64)
    const catalog: SkillRegistryCatalog = {
      schema_version: '1', registry: definition, revision,
      source_revision: revision, synced_at: '2026-01-01T00:00:00.000Z', skills: [], diagnostics: [],
    }
    await store.publishSnapshot(catalog, {
      schema_version: '1', definition, current_snapshot: revision,
      status: { state: 'ready' },
    })
    expect(await getEnabledSkillRegistryCatalogs(store)).toEqual([catalog])

    await store.putState({
      schema_version: '1', definition: { ...definition, enabled: false }, current_snapshot: revision,
      status: { state: 'disabled' },
    })
    expect(await getEnabledSkillRegistryCatalogs(store)).toEqual([])
    expect(await getEnabledSkillRegistryCatalogs(store, definition.id)).toEqual([])
  })

  test('reuses immutable Snapshots while still reading mutable state', async () => {
    const revision = 'b'.repeat(64)
    const catalog: SkillRegistryCatalog = {
      schema_version: '1', registry: definition, revision,
      source_revision: revision, synced_at: '2026-01-01T00:00:00.000Z', skills: [], diagnostics: [],
    }
    let stateReads = 0
    let snapshotReads = 0
    const store = {
      async listRegistryIDs() { return ['example'] },
      async getState() {
        stateReads++
        return {
          schema_version: '1' as const,
          definition,
          current_snapshot: revision,
          status: { state: 'ready' as const },
        }
      },
      async getSnapshot() {
        snapshotReads++
        return catalog
      },
    } as unknown as SkillRegistryStore

    await getEnabledSkillRegistryCatalogs(store)
    await getEnabledSkillRegistryCatalogs(store)
    expect(stateReads).toBe(2)
    expect(snapshotReads).toBe(1)
  })
})
