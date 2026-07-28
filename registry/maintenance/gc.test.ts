import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type {
  CatalogSkill,
  SkillArtifactDescriptor,
  SkillRegistryCatalog,
  SkillRegistryDefinition,
} from '../types'
import { LocalSkillRegistryStore } from '../storage/local'
import { sha256 } from '../digest'
import { garbageCollectSkillRegistries } from './gc'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

function definition(id: string, retention = 2): SkillRegistryDefinition {
  return {
    schema_version: '1', id, name: id, enabled: true, priority: 10,
    adapter: 'skill_directory', source: { type: 'local', path: 'skills' },
    refresh_interval_seconds: 43_200, retention: { snapshots: retention },
  }
}

async function putArtifact(store: LocalSkillRegistryStore, id: string) {
  const bytes = new TextEncoder().encode(`artifact:${id}`)
  const digest = await sha256(bytes)
  const descriptor: SkillArtifactDescriptor & { package_id: string; skill_id: string } = {
    package_id: 'package', skill_id: id,
    format: 'memoh_skill_v1', digest, size: bytes.length, content_type: 'application/gzip',
  }
  await store.putArtifact(descriptor, bytes)
  return descriptor
}

async function putImage(store: LocalSkillRegistryStore, id: string) {
  const bytes = new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg"><title>${id}</title></svg>`)
  const descriptor = { digest: await sha256(bytes), size: bytes.length, content_type: 'image/svg+xml' as const }
  await store.putImage(descriptor, bytes)
  return descriptor
}

function catalog(
  definition: SkillRegistryDefinition,
  revision: string,
  syncedAt: string,
  artifact: SkillArtifactDescriptor & { package_id: string; skill_id: string },
): SkillRegistryCatalog {
  const skill: CatalogSkill = {
    schema_version: '1', registry_id: definition.id, registry_priority: definition.priority,
    package_id: artifact.package_id, skill_id: artifact.skill_id,
    install_id: `${definition.id}+${artifact.package_id}+${artifact.skill_id}`,
    name: artifact.skill_id, description: artifact.skill_id, author: { name: 'Test', email: '' },
    tags: [], category: 'other', category_name: 'Other', runtime_requirements: { os: ['linux'] },
    source: { type: 'local', revision: 'source', path: `skills/${artifact.skill_id}` },
    files: ['SKILL.md'],
    artifact: {
      format: artifact.format, digest: artifact.digest, size: artifact.size, content_type: artifact.content_type,
    },
  }
  return {
    schema_version: '1', registry: definition, revision,
    source_revision: 'source', synced_at: syncedAt, skills: [skill], diagnostics: [],
  }
}

type FixtureStore = LocalSkillRegistryStore & {
  putDefinition(value: SkillRegistryDefinition): Promise<void>
  publishCatalog(value: SkillRegistryCatalog): Promise<void>
  getCatalog(id: string): Promise<SkillRegistryCatalog | null>
}

function fixture(store: LocalSkillRegistryStore): FixtureStore {
  return Object.assign(store, {
    async putDefinition(value: SkillRegistryDefinition) {
      const existing = await store.getState(value.id)
      await store.putState({
        schema_version: '1', definition: value, current_snapshot: existing?.current_snapshot,
        status: existing?.status ?? { state: 'empty' },
      })
    },
    async publishCatalog(value: SkillRegistryCatalog) {
      const existing = await store.getState(value.registry.id)
      await store.publishSnapshot(value, {
        schema_version: '1', definition: value.registry, current_snapshot: value.revision,
        status: existing?.status ?? { state: 'ready' },
      })
    },
    async getCatalog(id: string) {
      const current = await store.getState(id)
      return current?.current_snapshot ? store.getSnapshot(id, current.current_snapshot) : null
    },
  })
}

describe('Skill Registry garbage collection', () => {
  test('defaults to dry-run and only deletes snapshots and artifacts outside every retained graph', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skill-registry-gc-'))
    roots.push(root)
    const store = fixture(new LocalSkillRegistryStore(root))
    const known = definition('known', 2)
    const unmanaged = definition('unmanaged', 1)
    const oldArtifact = await putArtifact(store, 'old')
    const liveArtifact = await putArtifact(store, 'live')
    const orphanArtifact = await putArtifact(store, 'orphan')
    const unmanagedArtifact = await putArtifact(store, 'unmanaged')
    const liveImage = await putImage(store, 'live')
    const orphanImage = await putImage(store, 'orphan')
    const revisions = await Promise.all(['old', 'middle', 'current', 'unmanaged'].map(sha256))

    await store.putDefinition(known)
    await store.publishCatalog(catalog(known, revisions[0]!, '2026-01-01T00:00:00.000Z', oldArtifact))
    await store.publishCatalog(catalog(known, revisions[1]!, '2026-01-02T00:00:00.000Z', liveArtifact))
    const currentCatalog = catalog(known, revisions[2]!, '2026-01-03T00:00:00.000Z', liveArtifact)
    currentCatalog.skills[0]!.icon = { card: liveImage }
    await store.publishCatalog(currentCatalog)
    await store.putDefinition(unmanaged)
    await store.publishCatalog(catalog(unmanaged, revisions[3]!, '2026-01-04T00:00:00.000Z', unmanagedArtifact))

    const dryRun = await garbageCollectSkillRegistries({ store, definitions: [known] })
    expect(dryRun.applied).toBe(false)
    expect(dryRun.registries.find((item) => item.registry_id === 'known')?.deleted_snapshots).toEqual([revisions[0]!])
    expect(dryRun.registries.find((item) => item.registry_id === 'unmanaged')?.protected_reason).toBe('unmanaged_registry')
    expect(dryRun.artifacts.deleted.sort()).toEqual([oldArtifact.digest, orphanArtifact.digest].sort())
    expect(dryRun.images.deleted).toEqual([orphanImage.digest])
    expect(await store.getArtifact(oldArtifact.digest)).not.toBeNull()
    expect(await store.listSnapshots('known')).toHaveLength(3)

    await expect(garbageCollectSkillRegistries({ store, definitions: [known], apply: true }))
      .rejects.toThrow('writer lock guard')
    const applied = await garbageCollectSkillRegistries({
      store, definitions: [known], apply: true, assertWriterActive: () => {},
    })
    expect(applied.applied).toBe(true)
    expect((await store.listSnapshots('known')).map((item) => item.revision).sort())
      .toEqual([revisions[1]!, revisions[2]!].sort())
    expect((await store.getCatalog('known'))?.revision).toBe(revisions[2])
    expect(await store.getArtifact(oldArtifact.digest)).toBeNull()
    expect(await store.getArtifact(orphanArtifact.digest)).toBeNull()
    expect(await store.getArtifact(liveArtifact.digest)).not.toBeNull()
    expect(await store.getArtifact(unmanagedArtifact.digest)).not.toBeNull()
    expect(await store.getImage(orphanImage.digest)).toBeNull()
    expect(await store.getImage(liveImage.digest)).not.toBeNull()
  })

  test('always retains a current Snapshot that was rolled back behind the retention window', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skill-registry-gc-rollback-'))
    roots.push(root)
    const store = fixture(new LocalSkillRegistryStore(root))
    const known = definition('known', 1)
    const oldArtifact = await putArtifact(store, 'rollback')
    const newArtifact = await putArtifact(store, 'new')
    const oldRevision = await sha256('rollback-old')
    const newRevision = await sha256('rollback-new')
    await store.putDefinition(known)
    await store.publishCatalog(catalog(known, oldRevision, '2026-01-01T00:00:00.000Z', oldArtifact))
    await store.publishCatalog(catalog(known, newRevision, '2026-01-02T00:00:00.000Z', newArtifact))
    const statePath = path.join(root, 'skill-registries/known/state.json')
    const state = JSON.parse(await Bun.file(statePath).text())
    await Bun.write(statePath, JSON.stringify({ ...state, current_snapshot: oldRevision }))

    const result = await garbageCollectSkillRegistries({ store, definitions: [known] })
    const registry = result.registries.find((item) => item.registry_id === 'known')
    expect(registry?.retained_snapshots.sort()).toEqual([oldRevision, newRevision].sort())
    expect(registry?.deleted_snapshots).toEqual([])
    expect(result.artifacts.deleted).toEqual([])
  })

  test('fails closed on unknown Snapshot objects and malformed Artifact references', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skill-registry-gc-invalid-'))
    roots.push(root)
    const store = fixture(new LocalSkillRegistryStore(root))
    const known = definition('known', 1)
    const artifact = await putArtifact(store, 'valid')
    const revision = await sha256('valid-catalog')
    await store.putDefinition(known)
    await store.publishCatalog(catalog(known, revision, '2026-01-01T00:00:00.000Z', artifact))
    const snapshotsRoot = path.join(root, 'skill-registries/known/snapshots')

    await Bun.write(path.join(snapshotsRoot, 'legacy.json'), '{}')
    await expect(garbageCollectSkillRegistries({ store, definitions: [known] }))
      .rejects.toThrow('Unexpected object')
    expect(await store.getArtifact(artifact.digest)).not.toBeNull()
    await rm(path.join(snapshotsRoot, 'legacy.json'))

    const malformedRevision = await sha256('malformed-catalog')
    await Bun.write(path.join(snapshotsRoot, `${malformedRevision}.json`), JSON.stringify({
      schema_version: '1', registry: known, revision: malformedRevision,
      source_revision: 'source',
      synced_at: '2026-01-02T00:00:00.000Z', diagnostics: [],
      skills: [{ schema_version: '1', registry_id: 'known', package_id: 'package', skill_id: 'broken', artifact: { digest: 'bad' } }],
    }))
    await expect(garbageCollectSkillRegistries({ store, definitions: [known] }))
      .rejects.toThrow('Invalid stored Catalog Artifact reference')
    expect(await store.getArtifact(artifact.digest)).not.toBeNull()
  })

  test('protects managed history without a current snapshot', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skill-registry-gc-failures-'))
    roots.push(root)
    const store = fixture(new LocalSkillRegistryStore(root))
    const known = definition('known', 1)
    const oldArtifact = await putArtifact(store, 'failure-old')
    const currentArtifact = await putArtifact(store, 'failure-current')
    const orphanArtifact = await putArtifact(store, 'failure-orphan')
    const oldRevision = await sha256('failure-old')
    const currentRevision = await sha256('failure-current')
    await store.putDefinition(known)
    await store.publishCatalog(catalog(known, oldRevision, '2026-01-01T00:00:00.000Z', oldArtifact))
    await store.publishCatalog(catalog(known, currentRevision, '2026-01-02T00:00:00.000Z', currentArtifact))

    const currentPath = path.join(root, 'skill-registries/known/state.json')
    await rm(currentPath)
    const protectedResult = await garbageCollectSkillRegistries({ store, definitions: [known] })
    expect(protectedResult.registries[0]?.protected_reason).toBe('missing_current')
    expect(protectedResult.registries[0]?.deleted_snapshots).toEqual([])
    expect(protectedResult.artifacts.deleted).toEqual([orphanArtifact.digest])
    expect(await store.getArtifact(oldArtifact.digest)).not.toBeNull()
    expect(await store.getArtifact(currentArtifact.digest)).not.toBeNull()
  })

  test('rechecks current after Snapshot deletion before deleting Artifacts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skill-registry-gc-current-race-'))
    roots.push(root)
    const store = fixture(new LocalSkillRegistryStore(root))
    const known = definition('known', 2)
    const oldArtifact = await putArtifact(store, 'race-old')
    const retainedArtifact = await putArtifact(store, 'race-retained')
    const currentArtifact = await putArtifact(store, 'race-current')
    const orphanArtifact = await putArtifact(store, 'race-orphan')
    const revisions = await Promise.all(['race-old', 'race-retained', 'race-current'].map(sha256))
    await store.putDefinition(known)
    await store.publishCatalog(catalog(known, revisions[0]!, '2026-01-01T00:00:00.000Z', oldArtifact))
    await store.publishCatalog(catalog(known, revisions[1]!, '2026-01-02T00:00:00.000Z', retainedArtifact))
    await store.publishCatalog(catalog(known, revisions[2]!, '2026-01-03T00:00:00.000Z', currentArtifact))
    const currentPath = path.join(root, 'skill-registries/known/state.json')
    const changingStore = new Proxy(store, {
      get(target, property) {
        if (property === 'deleteSnapshot') {
          return async (registryID: string, revision: string) => {
            await target.deleteSnapshot(registryID, revision)
            const state = await target.getState(known.id)
            await Bun.write(currentPath, JSON.stringify({ ...state, current_snapshot: revisions[1] }))
          }
        }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    await expect(garbageCollectSkillRegistries({
      store: changingStore, definitions: [known], apply: true, assertWriterActive: () => {},
    })).rejects.toThrow('Current Snapshot changed')
    expect(await store.getArtifact(oldArtifact.digest)).not.toBeNull()
    expect(await store.getArtifact(orphanArtifact.digest)).not.toBeNull()
  })
})
