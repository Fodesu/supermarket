import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { serializeRegistrySnapshot } from '#registry/snapshot'
import { LocalSkillRegistryStore } from '#registry/storage/local'
import type { SkillRegistryDefinition, SkillRegistrySnapshot } from '#registry/types'
import { assertPartialRegistrySnapshotsPublished } from './publish'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

const definition = (id: string): SkillRegistryDefinition => ({
  schema_version: '1',
  id,
  name: id,
  enabled: true,
  priority: 10,
  adapter: { type: 'skill_directory' },
  source: { type: 'local', path: `registries/${id}/skills` },
})

async function publishedDependency() {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'partial-registry-data-'))
  roots.push(dataRoot)
  const store = new LocalSkillRegistryStore(dataRoot)
  const snapshot: SkillRegistrySnapshot = {
    schema_version: '1', registry_id: 'other', registry_priority: 10,
    source: { type: 'local', revision: 'source-revision' },
    packages: [{
      package_id: 'tools', name: 'tools', description: 'Search', tags: [],
      skills: [{
        skill_id: 'search', name: 'Search', description: 'Search',
        author: { name: 'Test' }, tags: [], category: 'tools', category_name: 'Tools',
        source_path: 'tools/search', files: ['SKILL.md'],
        artifact: {
          digest: 'b'.repeat(64), size: 1,
          uncompressed_size: 1, archive_size: 1, file_count: 1,
        },
      }],
    }],
    diagnostics: [],
  }
  const revision = await store.publishSnapshot(serializeRegistrySnapshot(snapshot), definition('other'))
  return { store, candidate: { definition: definition('other'), revision }, dataRoot }
}

describe('partial Registry publication', () => {
  test('fails before publication when another approved Registry is absent from the Store', async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'partial-registry-data-'))
    roots.push(dataRoot)
    const other = definition('other')
    const candidate = { definition: other, revision: 'a'.repeat(64) }

    await expect(assertPartialRegistrySnapshotsPublished({
      selectedRegistry: 'selected',
      candidates: [candidate],
      store: new LocalSkillRegistryStore(dataRoot),
    })).rejects.toThrow('run a full Registry publication first')
  })

  test('requires only the approved Snapshot for every unchanged Registry', async () => {
    const dependency = await publishedDependency()
    await expect(assertPartialRegistrySnapshotsPublished({
      selectedRegistry: 'selected', candidates: [dependency.candidate], store: dependency.store,
    })).resolves.toBeUndefined()

    await rm(path.join(
      dependency.dataRoot,
      `skill-registries/other/snapshots/${dependency.candidate.revision}.json`,
    ))
    await expect(assertPartialRegistrySnapshotsPublished({
      selectedRegistry: 'selected', candidates: [dependency.candidate], store: dependency.store,
    })).rejects.toThrow('approved Registry Snapshot is missing')
  })
})
