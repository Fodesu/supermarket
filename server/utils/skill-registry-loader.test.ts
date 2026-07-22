import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { SkillRegistryCatalog, SkillRegistryDefinition } from '../types/skill-registry'
import { LocalSkillRegistryStore } from './local-skill-registry-store'
import { getEnabledSkillRegistryCatalogs, getRuntimeSkillRegistryStore } from './skill-registry-loader'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

const definition: SkillRegistryDefinition = {
  schema_version: '1', id: 'example', name: 'Example', enabled: true, priority: 10,
  adapter: 'skill_directory', source: { type: 'local', path: 'skills' }, refresh_interval_seconds: 43_200,
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
      schema_version: '1', registry: definition, revision, content_revision: revision,
      source_revision: revision, synced_at: '2026-01-01T00:00:00.000Z', skills: [], diagnostics: [],
    }
    await store.putDefinition(definition)
    await store.publishCatalog(catalog)
    expect(await getEnabledSkillRegistryCatalogs(store)).toEqual([catalog])

    await store.putDefinition({ ...definition, enabled: false })
    expect(await getEnabledSkillRegistryCatalogs(store)).toEqual([])
    expect(await getEnabledSkillRegistryCatalogs(store, definition.id)).toEqual([])
  })
})
