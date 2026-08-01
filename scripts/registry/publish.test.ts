import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { sha256 } from '#registry/digest'
import { serializeRegistrySnapshot } from '#registry/snapshot'
import { LocalSkillRegistryStore } from '#registry/storage/local'
import type { SkillRegistryDefinition, SkillRegistrySnapshot } from '#registry/types'
import { assertPartialRegistryDependencies } from './publish'

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

async function publishedDependency(input: { publishArtifact?: boolean; snapshotSizeOffset?: number } = {}) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'partial-registry-data-'))
  roots.push(dataRoot)
  const store = new LocalSkillRegistryStore(dataRoot)
  const bytes = new TextEncoder().encode('artifact')
  const digest = await sha256(bytes)
  const snapshot: SkillRegistrySnapshot = {
    schema_version: '1', registry_id: 'other', registry_priority: 10,
    source: { type: 'local', revision: 'source-revision' },
    skills: [{
      package_id: 'tools', skill_id: 'search', name: 'Search', description: 'Search',
      author: { name: 'Test' }, tags: [], category: 'tools', category_name: 'Tools',
      source_path: 'tools/search', files: ['SKILL.md'],
      artifact: { digest, size: bytes.length + (input.snapshotSizeOffset ?? 0) },
    }],
    diagnostics: [],
  }
  const revision = await store.publishSnapshot(serializeRegistrySnapshot(snapshot), definition('other'))
  if (input.publishArtifact) {
    await store.putArtifact({
      format: 'memoh_skill_v1', digest, size: bytes.length, content_type: 'application/gzip',
    }, bytes)
  }
  return { store, candidate: { definition: definition('other'), revision }, dataRoot, digest }
}

describe('partial Registry publication', () => {
  test('fails before publication when another approved Registry is absent from the Store', async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'partial-registry-data-'))
    roots.push(dataRoot)
    const other = definition('other')
    const candidate = { definition: other, revision: 'a'.repeat(64) }

    await expect(assertPartialRegistryDependencies({
      selectedRegistry: 'selected',
      candidates: [candidate],
      store: new LocalSkillRegistryStore(dataRoot),
    })).rejects.toThrow('run a full Registry publication first')
  })

  test('requires every Artifact referenced by an unchanged Registry Snapshot', async () => {
    const missing = await publishedDependency()
    await expect(assertPartialRegistryDependencies({
      selectedRegistry: 'selected', candidates: [missing.candidate], store: missing.store,
    })).rejects.toThrow('approved Registry Artifact is missing')

    const ready = await publishedDependency({ publishArtifact: true })
    await expect(assertPartialRegistryDependencies({
      selectedRegistry: 'selected', candidates: [ready.candidate], store: ready.store,
    })).resolves.toBeUndefined()
  })

  test('rejects an Artifact whose size does not match the approved Snapshot', async () => {
    const dependency = await publishedDependency({ publishArtifact: true, snapshotSizeOffset: 1 })
    await expect(assertPartialRegistryDependencies({
      selectedRegistry: 'selected', candidates: [dependency.candidate], store: dependency.store,
    })).rejects.toThrow('does not match its descriptor')
  })

  test('rejects an Artifact whose bytes do not match its digest', async () => {
    const dependency = await publishedDependency({ publishArtifact: true })
    await Bun.write(
      path.join(dependency.dataRoot, 'skill-artifacts', `${dependency.digest}.tar.gz`),
      'corrupt!',
    )
    await expect(assertPartialRegistryDependencies({
      selectedRegistry: 'selected', candidates: [dependency.candidate], store: dependency.store,
    })).rejects.toThrow('approved Registry Artifact content is corrupt')
  })
})
