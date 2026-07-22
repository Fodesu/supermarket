import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MAX_SKILL_ARTIFACT_COMPRESSED_BYTES } from '../types/skill-registry'
import type { SkillArtifactDescriptor, SkillRegistryCatalog, SkillRegistryDefinition } from '../types/skill-registry'
import { LocalSkillRegistryStore } from './local-skill-registry-store'
import { BlobSkillRegistryStore, R2BlobBackend, sha256 } from './skill-registry-store'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

const definition: SkillRegistryDefinition = {
  schema_version: '1', id: 'example', name: 'Example', enabled: true, priority: 10,
  adapter: 'skill_directory', source: { type: 'local', path: 'skills' }, refresh_interval_seconds: 43_200,
}

function catalog(revision: string): SkillRegistryCatalog {
  return {
    schema_version: '1', registry: definition, revision, content_revision: revision,
    source_revision: revision, synced_at: '2026-01-01T00:00:00.000Z', skills: [], diagnostics: [],
  }
}

async function exerciseStore(store: LocalSkillRegistryStore | BlobSkillRegistryStore) {
  await store.putDefinition(definition)
  expect((await store.getDefinition('example'))?.name).toBe('Example')
  const revision = 'a'.repeat(64)
  await store.publishCatalog(catalog(revision))
  await expect(store.publishCatalog({ ...catalog(revision), synced_at: '2026-01-02T00:00:00.000Z' })).resolves.toBeUndefined()
  expect((await store.getCatalog('example'))?.revision).toBe(revision)
  expect(await store.listRegistryIDs()).toEqual(['example'])

  const bytes = new TextEncoder().encode('artifact')
  const digest = await sha256(bytes)
  const descriptor: SkillArtifactDescriptor = {
    registry_id: 'example', package_id: 'package', skill_id: 'skill', source_revision: revision,
    format: 'memoh_skill_v1', digest, size: bytes.length, filename: 'skill.tar.gz',
    content_type: 'application/gzip', created_at: '2026-01-01T00:00:00.000Z',
  }
  await store.putArtifact(descriptor, bytes)
  const artifact = await store.getArtifact(digest)
  expect(artifact?.bytes).toEqual(bytes)
  expect(artifact?.descriptor).toEqual({
    format: 'memoh_skill_v1', digest, size: bytes.length, content_type: 'application/gzip',
  })
  await expect(store.putArtifact({ ...descriptor, source_revision: 'b'.repeat(64) }, bytes)).resolves.toBeUndefined()
  await expect(store.putArtifact({ ...descriptor, size: bytes.length + 1 }, bytes)).rejects.toThrow('size')
  await expect(store.putArtifact({ ...descriptor, size: MAX_SKILL_ARTIFACT_COMPRESSED_BYTES + 1 }, bytes))
    .rejects.toThrow('compressed size limit')
}

describe('SkillRegistryStore contract', () => {
  test('Local store publishes catalogs before pointers and stores content-addressed artifacts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skill-registry-store-'))
    roots.push(root)
    const store = new LocalSkillRegistryStore(root)
    await exerciseStore(store)
    const pointer = JSON.parse(await readFile(path.join(root, 'skill-registries/example/current.json'), 'utf8'))
    expect(pointer.revision).toBe('a'.repeat(64))
  })

  test('R2 backend handles paginated object listings', async () => {
    const objects = new Map<string, Uint8Array>()
    const bucket = {
      async get(key: string) {
        const value = objects.get(key)
        return value ? { arrayBuffer: async () => value.slice().buffer } : null
      },
      async put(key: string, value: Uint8Array) { objects.set(key, value.slice()) },
      async list({ prefix = '', cursor }: { prefix?: string; cursor?: string } = {}) {
        const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort()
        const offset = cursor ? Number(cursor) : 0
        const page = keys.slice(offset, offset + 1)
        return { objects: page.map((key) => ({ key })), truncated: offset + page.length < keys.length, cursor: String(offset + page.length) }
      },
    }
    await exerciseStore(new BlobSkillRegistryStore(new R2BlobBackend(bucket)))
  })
})
