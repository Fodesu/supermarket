import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { SkillRegistryDefinition, SkillRegistrySnapshot } from '#registry/types'
import { LocalSkillRegistryStore } from '#registry/storage/local'
import { summarizeCurrentSnapshot } from '#registry/catalog'
import type { SkillRegistryStore } from '#registry/storage/contracts'
import { registrySnapshotRevision, serializeRegistrySnapshot } from '#registry/snapshot'
import {
  getEnabledSkillRegistrySnapshots,
  getSkillRegistryDetailsForStore,
  getRuntimeSkillRegistryStore,
  getSkillRegistrySummariesForStore,
} from './skill-registry'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

const definition: SkillRegistryDefinition = {
  schema_version: '1', id: 'example', name: 'Example', enabled: true, priority: 10,
  adapter: { type: 'skill_directory' }, source: { type: 'local', path: 'skills' },
}

function snapshot(registryID = 'example', sourceRevision = 'source'): SkillRegistrySnapshot {
  return {
    schema_version: '1',
    registry_id: registryID,
    registry_priority: 10,
    source: { type: 'local', revision: sourceRevision },
    skills: [],
    diagnostics: [],
  }
}

function snapshotState(
  value: SkillRegistrySnapshot,
) {
  const revision = registrySnapshotRevision(serializeRegistrySnapshot(value))
  return {
    revision,
    summary: summarizeCurrentSnapshot(value, revision, '2026-01-01T00:00:00.000Z'),
  }
}

describe('Skill Registry loader', () => {
  test('fails explicitly when a Cloudflare runtime has no R2 binding', async () => {
    await expect(getRuntimeSkillRegistryStore({ req: { runtime: { cloudflare: { env: {} } } } }))
      .rejects.toThrow('SKILL_REGISTRY_BUCKET')
  })

  test('stops serving a previous Snapshot when its Registry is disabled', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skill-registry-loader-'))
    roots.push(root)
    const store = new LocalSkillRegistryStore(root)
    const approved = snapshot()
    const revision = await store.publishSnapshot(serializeRegistrySnapshot(approved), definition, {
      publishedAt: '2026-01-01T00:00:00.000Z',
    })
    expect(await getEnabledSkillRegistrySnapshots(store)).toEqual([approved])

    await store.putState({
      schema_version: '1',
      definition: { ...definition, enabled: false },
      current_snapshot: revision,
      current_summary: summarizeCurrentSnapshot(approved, revision, '2026-01-01T00:00:00.000Z'),
    })
    expect(await getEnabledSkillRegistrySnapshots(store)).toEqual([])
    expect(await getEnabledSkillRegistrySnapshots(store, definition.id)).toEqual([])
  })

  test('does not expose disabled Registries through summaries or details', async () => {
    const disabled = { ...definition, enabled: false }
    const current = snapshotState(snapshot())
    const store = {
      async listRegistryIDs() { return ['example'] },
      async getState() {
        return {
          schema_version: '1' as const,
          definition: disabled,
          current_snapshot: current.revision,
          current_summary: current.summary,
        }
      },
    } as unknown as SkillRegistryStore

    await expect(getSkillRegistrySummariesForStore(store)).resolves.toEqual([])
    await expect(getSkillRegistryDetailsForStore(store, 'example')).resolves.toBeUndefined()
  })

  test('reads one state version when loading Registry details', async () => {
    const approved = snapshot('example', 'source')
    const current = snapshotState(approved)
    let stateReads = 0
    const store = {
      async getState() {
        stateReads++
        return {
          schema_version: '1' as const,
          definition,
          current_snapshot: current.revision,
          current_summary: current.summary,
        }
      },
      async getSnapshot() { return approved },
    } as unknown as SkillRegistryStore

    await expect(getSkillRegistryDetailsForStore(store, 'example')).resolves.toMatchObject({ source_revision: 'source' })
    expect(stateReads).toBe(1)
  })

  test('reuses immutable Snapshots while still reading mutable state', async () => {
    const approved = snapshot('example', 'source')
    const { revision, summary } = snapshotState(approved)
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
          current_summary: summary,
        }
      },
      async getSnapshot() {
        snapshotReads++
        return approved
      },
    } as unknown as SkillRegistryStore

    await getEnabledSkillRegistrySnapshots(store)
    await getEnabledSkillRegistrySnapshots(store)
    expect(stateReads).toBe(2)
    expect(snapshotReads).toBe(1)
  })

  test('loads Registry summaries from state without reading Snapshots', async () => {
    const second = { ...definition, id: 'second', name: 'Second' }
    const firstSnapshot = snapshot('example', 'first')
    const secondSnapshot = snapshot('second', 'second')
    const first = snapshotState(firstSnapshot)
    const secondState = snapshotState(secondSnapshot)
    const store = {
      async listRegistryIDs() { return ['example', 'second'] },
      async getState(id: string) {
        const current = id === 'example'
          ? { definition, ...first }
          : { definition: second, ...secondState }
        return {
          schema_version: '1' as const,
          definition: current.definition,
          current_snapshot: current.revision,
          current_summary: current.summary,
        }
      },
      async getSnapshot() {
        throw new Error('Registry summaries must not read Snapshots')
      },
    } as unknown as SkillRegistryStore

    await expect(getSkillRegistrySummariesForStore(store)).resolves.toMatchObject([
      { id: 'example', revision: first.revision, skill_count: 0 },
      { id: 'second', revision: secondState.revision, skill_count: 0 },
    ])
  })
})
