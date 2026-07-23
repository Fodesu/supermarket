import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type {
  CatalogSkill,
  SkillArtifactDescriptor,
  SkillRegistryCatalog,
  SkillRegistryDefinition,
} from '../../server/types/skill-registry'
import { LocalSkillRegistryStore } from '../../server/utils/local-skill-registry-store'
import { sha256 } from '../../server/utils/skill-registry-store'
import { garbageCollectSkillRegistries } from './gc'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

function definition(id: string, retention = 2): SkillRegistryDefinition {
  return {
    schema_version: '1', id, name: id, enabled: true, priority: 10,
    adapter: 'skill_directory', source: { type: 'local', path: 'skills' },
    refresh_interval_seconds: 43_200, retention: { catalog_revisions: retention },
  }
}

async function putArtifact(store: LocalSkillRegistryStore, id: string) {
  const bytes = new TextEncoder().encode(`artifact:${id}`)
  const digest = await sha256(bytes)
  const descriptor: SkillArtifactDescriptor = {
    registry_id: 'known', package_id: 'package', skill_id: id, source_revision: 'source',
    format: 'memoh_skill_v1', digest, size: bytes.length, filename: `${id}.tar.gz`,
    content_type: 'application/gzip', created_at: '2026-01-01T00:00:00.000Z',
  }
  await store.putArtifact(descriptor, bytes)
  return descriptor
}

function catalog(definition: SkillRegistryDefinition, revision: string, syncedAt: string, artifact: SkillArtifactDescriptor): SkillRegistryCatalog {
  const skill: CatalogSkill = {
    schema_version: '1', registry_id: definition.id, registry_priority: definition.priority,
    package_id: artifact.package_id, skill_id: artifact.skill_id,
    install_id: `${definition.id}+${artifact.package_id}+${artifact.skill_id}`,
    name: artifact.skill_id, description: artifact.skill_id, author: { name: 'Test', email: '' },
    tags: [], category: 'other', category_name: 'Other', runtime_requirements: { os: ['linux'] },
    source: { type: 'local', revision: 'source', path: `skills/${artifact.skill_id}` },
    files: ['SKILL.md'], artifact: { ...artifact, registry_id: definition.id },
  }
  return {
    schema_version: '1', registry: definition, revision, content_revision: revision,
    source_revision: 'source', synced_at: syncedAt, skills: [skill], diagnostics: [],
  }
}

describe('Skill Registry garbage collection', () => {
  test('defaults to dry-run and only deletes catalogs and artifacts outside every retained graph', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skill-registry-gc-'))
    roots.push(root)
    const store = new LocalSkillRegistryStore(root)
    const known = definition('known', 2)
    const unmanaged = definition('unmanaged', 1)
    const oldArtifact = await putArtifact(store, 'old')
    const liveArtifact = await putArtifact(store, 'live')
    const orphanArtifact = await putArtifact(store, 'orphan')
    const unmanagedArtifact = await putArtifact(store, 'unmanaged')
    const revisions = await Promise.all(['old', 'middle', 'current', 'unmanaged'].map(sha256))

    await store.putDefinition(known)
    await store.publishCatalog(catalog(known, revisions[0]!, '2026-01-01T00:00:00.000Z', oldArtifact))
    await store.publishCatalog(catalog(known, revisions[1]!, '2026-01-02T00:00:00.000Z', liveArtifact))
    await store.publishCatalog(catalog(known, revisions[2]!, '2026-01-03T00:00:00.000Z', liveArtifact))
    await store.putDefinition(unmanaged)
    await store.publishCatalog(catalog(unmanaged, revisions[3]!, '2026-01-04T00:00:00.000Z', unmanagedArtifact))

    const dryRun = await garbageCollectSkillRegistries({ store, definitions: [known] })
    expect(dryRun.applied).toBe(false)
    expect(dryRun.registries.find((item) => item.registry_id === 'known')?.deleted_revisions).toEqual([revisions[0]!])
    expect(dryRun.registries.find((item) => item.registry_id === 'unmanaged')?.protected_reason).toBe('unmanaged_registry')
    expect(dryRun.artifacts.deleted.sort()).toEqual([oldArtifact.digest, orphanArtifact.digest].sort())
    expect(await store.getArtifact(oldArtifact.digest)).not.toBeNull()
    expect(await store.listCatalogRevisions('known')).toHaveLength(3)

    await expect(garbageCollectSkillRegistries({ store, definitions: [known], apply: true }))
      .rejects.toThrow('writer lock guard')
    const applied = await garbageCollectSkillRegistries({
      store, definitions: [known], apply: true, assertWriterLease: () => {},
    })
    expect(applied.applied).toBe(true)
    expect((await store.listCatalogRevisions('known')).map((item) => item.revision).sort())
      .toEqual([revisions[1]!, revisions[2]!].sort())
    expect((await store.getCatalog('known'))?.revision).toBe(revisions[2])
    expect(await store.getArtifact(oldArtifact.digest)).toBeNull()
    expect(await store.getArtifact(orphanArtifact.digest)).toBeNull()
    expect(await store.getArtifact(liveArtifact.digest)).not.toBeNull()
    expect(await store.getArtifact(unmanagedArtifact.digest)).not.toBeNull()
  })

  test('always retains a current Catalog that was rolled back behind the retention window', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skill-registry-gc-rollback-'))
    roots.push(root)
    const store = new LocalSkillRegistryStore(root)
    const known = definition('known', 1)
    const oldArtifact = await putArtifact(store, 'rollback')
    const newArtifact = await putArtifact(store, 'new')
    const oldRevision = await sha256('rollback-old')
    const newRevision = await sha256('rollback-new')
    await store.putDefinition(known)
    await store.publishCatalog(catalog(known, oldRevision, '2026-01-01T00:00:00.000Z', oldArtifact))
    await store.publishCatalog(catalog(known, newRevision, '2026-01-02T00:00:00.000Z', newArtifact))
    await Bun.write(path.join(root, 'skill-registries/known/current.json'), JSON.stringify({ revision: oldRevision }))

    const result = await garbageCollectSkillRegistries({ store, definitions: [known] })
    const registry = result.registries.find((item) => item.registry_id === 'known')
    expect(registry?.retained_revisions.sort()).toEqual([oldRevision, newRevision].sort())
    expect(registry?.deleted_revisions).toEqual([])
    expect(result.artifacts.deleted).toEqual([])
  })

  test('fails closed on unknown Catalog objects and malformed Artifact references', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skill-registry-gc-invalid-'))
    roots.push(root)
    const store = new LocalSkillRegistryStore(root)
    const known = definition('known', 1)
    const artifact = await putArtifact(store, 'valid')
    const revision = await sha256('valid-catalog')
    await store.putDefinition(known)
    await store.publishCatalog(catalog(known, revision, '2026-01-01T00:00:00.000Z', artifact))
    const catalogsRoot = path.join(root, 'skill-registries/known/catalogs')

    await Bun.write(path.join(catalogsRoot, 'legacy.json'), '{}')
    await expect(garbageCollectSkillRegistries({ store, definitions: [known] }))
      .rejects.toThrow('Unexpected object')
    expect(await store.getArtifact(artifact.digest)).not.toBeNull()
    await rm(path.join(catalogsRoot, 'legacy.json'))

    const malformedRevision = await sha256('malformed-catalog')
    await Bun.write(path.join(catalogsRoot, `${malformedRevision}.json`), JSON.stringify({
      schema_version: '1', registry: known, revision: malformedRevision,
      content_revision: malformedRevision, source_revision: 'source',
      synced_at: '2026-01-02T00:00:00.000Z', diagnostics: [],
      skills: [{ schema_version: '1', registry_id: 'known', package_id: 'package', skill_id: 'broken', artifact: { digest: 'bad' } }],
    }))
    await expect(garbageCollectSkillRegistries({ store, definitions: [known] }))
      .rejects.toThrow('Invalid stored Catalog Skill')
    expect(await store.getArtifact(artifact.digest)).not.toBeNull()
  })

  test('protects managed history without current and stops before Artifact deletion on Catalog failure', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skill-registry-gc-failures-'))
    roots.push(root)
    const store = new LocalSkillRegistryStore(root)
    const known = definition('known', 1)
    const oldArtifact = await putArtifact(store, 'failure-old')
    const currentArtifact = await putArtifact(store, 'failure-current')
    const orphanArtifact = await putArtifact(store, 'failure-orphan')
    const oldRevision = await sha256('failure-old')
    const currentRevision = await sha256('failure-current')
    await store.putDefinition(known)
    await store.publishCatalog(catalog(known, oldRevision, '2026-01-01T00:00:00.000Z', oldArtifact))
    await store.publishCatalog(catalog(known, currentRevision, '2026-01-02T00:00:00.000Z', currentArtifact))

    const currentPath = path.join(root, 'skill-registries/known/current.json')
    await rm(currentPath)
    const protectedResult = await garbageCollectSkillRegistries({ store, definitions: [known] })
    expect(protectedResult.registries[0]?.protected_reason).toBe('missing_current')
    expect(protectedResult.registries[0]?.deleted_revisions).toEqual([])
    expect(protectedResult.artifacts.deleted).toEqual([orphanArtifact.digest])
    await Bun.write(currentPath, JSON.stringify({ revision: currentRevision }))

    const failingStore = new Proxy(store, {
      get(target, property) {
        if (property === 'deleteCatalogRevision') return async () => { throw new Error('catalog delete failed') }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    await expect(garbageCollectSkillRegistries({
      store: failingStore, definitions: [known], apply: true, assertWriterLease: () => {},
    })).rejects.toThrow('catalog delete failed')
    expect(await store.getArtifact(oldArtifact.digest)).not.toBeNull()
    expect(await store.getArtifact(orphanArtifact.digest)).not.toBeNull()
  })

  test('rechecks current after Catalog deletion before deleting Artifacts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skill-registry-gc-current-race-'))
    roots.push(root)
    const store = new LocalSkillRegistryStore(root)
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
    const currentPath = path.join(root, 'skill-registries/known/current.json')
    const changingStore = new Proxy(store, {
      get(target, property) {
        if (property === 'deleteCatalogRevision') {
          return async (registryID: string, revision: string) => {
            await target.deleteCatalogRevision(registryID, revision)
            await Bun.write(currentPath, JSON.stringify({ revision: revisions[1] }))
          }
        }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    await expect(garbageCollectSkillRegistries({
      store: changingStore, definitions: [known], apply: true, assertWriterLease: () => {},
    })).rejects.toThrow('Current Catalog changed')
    expect(await store.getArtifact(oldArtifact.digest)).not.toBeNull()
    expect(await store.getArtifact(orphanArtifact.digest)).not.toBeNull()
  })
})
