import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { gunzip, parseTarArchive } from '../../client/archive'
import type { SkillRegistryDefinition } from '../types'
import { LocalSkillRegistryStore } from '../storage/local'
import type { SkillRegistryStore } from '../storage/contracts'
import {
  isSkillRegistryRefreshDue,
  SkillRegistryRefresher,
  type SkillRegistryRefreshProgress,
} from './refresher'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

async function writeSkill(projectRoot: string, id: string, version: string) {
  const directory = path.join(projectRoot, 'skills', id)
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${id}\ndescription: Version ${version}\n---\n\n# ${id}\n`)
}

async function state(store: SkillRegistryStore, id: string) {
  return store.getState(id)
}

async function snapshot(store: SkillRegistryStore, id: string) {
  const current = await state(store, id)
  return current?.current_snapshot ? store.getSnapshot(id, current.current_snapshot) : null
}

describe('SkillRegistryRefresher', () => {
  test('uses each Registry refresh interval to determine whether it is due', () => {
    const definition: SkillRegistryDefinition = {
      schema_version: '1', id: 'memoh', name: 'Memoh', enabled: true, priority: 100,
      adapter: 'skill_directory', source: { type: 'local', path: 'skills' }, refresh_interval_seconds: 7_200,
      retention: { snapshots: 30 },
    }
    const lastSuccess = '2026-01-01T00:00:00.000Z'
    expect(isSkillRegistryRefreshDue(definition, { state: 'ready', last_success_at: lastSuccess }, Date.parse('2026-01-01T01:59:59.000Z'))).toBe(false)
    expect(isSkillRegistryRefreshDue(definition, { state: 'ready', last_success_at: lastSuccess }, Date.parse('2026-01-01T02:00:00.000Z'))).toBe(true)
    expect(isSkillRegistryRefreshDue(definition, null)).toBe(true)
  })

  test('publishes ready artifacts, supports scoped refresh and preserves last-known-good', async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'skill-refresher-project-'))
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'skill-refresher-data-'))
    roots.push(projectRoot, dataRoot)
    await writeSkill(projectRoot, 'alpha', '1')
    await writeSkill(projectRoot, 'beta', '1')
    const definition: SkillRegistryDefinition = {
      schema_version: '1', id: 'memoh', name: 'Memoh', enabled: true, priority: 100,
      adapter: 'skill_directory', source: { type: 'local', path: 'skills' }, refresh_interval_seconds: 43_200,
      retention: { snapshots: 30 },
    }
    const store = new LocalSkillRegistryStore(dataRoot)
    const refresher = new SkillRegistryRefresher(store, projectRoot)

    await expect(refresher.refresh(definition, { package: 'alpha' }))
      .rejects.toThrow('scoped refresh requires an existing Catalog')
    expect(await snapshot(store, 'memoh')).toBeNull()

    const first = await refresher.refresh(definition)
    expect(first.skills).toBe(2)
    const initial = await snapshot(store, 'memoh')
    expect(initial?.skills.every((skill) => skill.artifact.format === 'memoh_skill_v1')).toBe(true)
    for (const skill of initial!.skills) {
      const artifact = await store.getArtifact(skill.artifact.digest)
      expect(artifact).not.toBeNull()
      const files = parseTarArchive(await gunzip(artifact!.bytes))
      expect(files.has('SKILL.md')).toBe(true)
      expect([...files.keys()].some((name) => name.startsWith(`${skill.install_id}/`))).toBe(false)
    }

    const overlapping = refresher.refresh(definition)
    await expect(refresher.refresh(definition)).rejects.toThrow('another refresh is already running')
    await overlapping

    await Bun.sleep(5)
    expect(await refresher.refresh(definition)).toMatchObject({ revision: initial?.revision, skipped: 'unchanged' })
    const unchangedStatus = (await state(store, 'memoh'))?.status
    expect(Date.parse(unchangedStatus!.last_success_at!)).toBeGreaterThan(Date.parse(initial!.synced_at))
    await writeSkill(projectRoot, 'alpha', '2')
    await refresher.refresh(definition, { package: 'alpha', skill: 'alpha' })
    const updated = await snapshot(store, 'memoh')
    expect(updated?.skills).toHaveLength(2)
    expect(updated?.skills.find((skill) => skill.skill_id === 'alpha')?.description).toBe('Version 2')
    expect(updated?.skills.find((skill) => skill.skill_id === 'beta')?.description).toBe('Version 1')

    await expect(refresher.refresh({ ...definition, priority: 101 }, { package: 'alpha' }))
      .rejects.toThrow('unchanged Registry definition')
    expect((await state(store, 'memoh'))?.definition.priority).toBe(100)

    await rm(path.join(projectRoot, 'skills/beta'), { recursive: true })
    await refresher.refresh(definition, { package: 'beta' })
    expect((await snapshot(store, 'memoh'))?.skills.map((skill) => skill.skill_id)).toEqual(['alpha'])
    await expect(refresher.refresh(definition, { package: 'missing' })).rejects.toThrow('not found')

    await writeFile(path.join(projectRoot, 'skills/alpha/SKILL.md'), '# invalid')
    const beforeFailure = await snapshot(store, 'memoh')
    const lastSuccessAt = (await state(store, 'memoh'))?.status.last_success_at
    await expect(refresher.refresh({ ...definition, priority: 101 })).rejects.toThrow('frontmatter')
    expect((await state(store, 'memoh'))?.definition.priority).toBe(100)
    await expect(refresher.refresh(definition, { package: 'alpha' })).rejects.toThrow('frontmatter')
    expect((await snapshot(store, 'memoh'))?.revision).toBe(beforeFailure?.revision)
    expect((await state(store, 'memoh'))?.status.state).toBe('stale')
    expect((await state(store, 'memoh'))?.status.last_success_at).toBe(lastSuccessAt)
  })

  test('refreshes Git sources before deciding whether the snapshot changed', async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), 'skill-fastpath-repo-'))
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'skill-fastpath-project-'))
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'skill-fastpath-data-'))
    roots.push(repository, projectRoot, dataRoot)
    const git = async (...args: string[]) => {
      const child = Bun.spawn(['git', '-C', repository, ...args], { stdout: 'pipe', stderr: 'pipe' })
      const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited])
      if (exitCode !== 0) throw new Error(stderr)
    }
    await git('init', '-b', 'main')
    await git('config', 'user.email', 'test@example.com')
    await git('config', 'user.name', 'Test')
    await mkdir(path.join(repository, 'alpha'), { recursive: true })
    await writeFile(path.join(repository, 'alpha/SKILL.md'), '---\nname: alpha\ndescription: One\n---\n')
    await git('add', '.')
    await git('commit', '-m', 'one')

    const definition: SkillRegistryDefinition = {
      schema_version: '1', id: 'gitreg', name: 'Git Registry', enabled: true, priority: 100,
      adapter: 'skill_directory', source: { type: 'git', url: repository, ref: 'main' },
      refresh_interval_seconds: 43_200, retention: { snapshots: 30 },
    }
    const store = new LocalSkillRegistryStore(dataRoot)
    const events: SkillRegistryRefreshProgress[] = []
    const refresher = new SkillRegistryRefresher(store, projectRoot, undefined, (event) => events.push(event))

    const first = await refresher.refresh(definition)
    expect(first.skills).toBe(1)
    const firstStatus = (await state(store, 'gitreg'))?.status
    events.length = 0
    expect(await refresher.refresh(definition)).toMatchObject({ revision: first.revision, skipped: 'unchanged' })
    expect(events.map((event) => event.type)).toContain('source')
    expect(Date.parse((await state(store, 'gitreg'))!.status.last_success_at!))
      .toBeGreaterThanOrEqual(Date.parse(firstStatus!.last_success_at!))

    await writeFile(path.join(repository, 'README.md'), 'docs only')
    await git('add', '.')
    await git('commit', '-m', 'docs')
    expect(await refresher.refresh(definition)).toMatchObject({ revision: first.revision, skipped: 'unchanged' })

    const reprioritized = { ...definition, priority: 101 }
    const changedDefinition = await refresher.refresh(reprioritized)
    expect(changedDefinition.skipped).toBeUndefined()
    expect(changedDefinition.revision).not.toBe(first.revision)

    // A real Skill change publishes a new revision.
    await writeFile(path.join(repository, 'alpha/SKILL.md'), '---\nname: alpha\ndescription: Two\n---\n')
    await git('add', '.')
    await git('commit', '-m', 'two')
    const updated = await refresher.refresh(reprioritized)
    expect(updated.skipped).toBeUndefined()
    expect((await snapshot(store, 'gitreg'))?.skills[0]?.description).toBe('Two')
  })

  test('reports progress for uploads, cache hits, and skipped publications', async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'skill-progress-project-'))
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'skill-progress-data-'))
    roots.push(projectRoot, dataRoot)
    await writeSkill(projectRoot, 'alpha', '1')
    const definition: SkillRegistryDefinition = {
      schema_version: '1', id: 'memoh', name: 'Memoh', enabled: true, priority: 100,
      adapter: 'skill_directory', source: { type: 'local', path: 'skills' }, refresh_interval_seconds: 43_200,
      retention: { snapshots: 30 },
    }
    const events: SkillRegistryRefreshProgress[] = []
    const refresher = new SkillRegistryRefresher(
      new LocalSkillRegistryStore(dataRoot), projectRoot, undefined, (event) => events.push(event),
    )

    await refresher.refresh(definition)
    expect(events.map((event) => event.type)).toEqual(['source', 'source_ready', 'scanned', 'skill', 'publishing'])
    expect(events.find((event) => event.type === 'skill')).toMatchObject({
      index: 1, total: 1, package_id: 'alpha', skill_id: 'alpha', uploaded: true,
    })

    events.length = 0
    await refresher.refresh(definition)
    expect(events.find((event) => event.type === 'skill')).toMatchObject({ uploaded: false })
    expect(events.some((event) => event.type === 'publishing')).toBe(false)
  })

  test('recovers success status when publication committed before a status write failed', async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'skill-status-recovery-project-'))
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'skill-status-recovery-data-'))
    roots.push(projectRoot, dataRoot)
    await writeSkill(projectRoot, 'alpha', '1')
    const base = new LocalSkillRegistryStore(dataRoot)
    let failReadyState = true
    const store: SkillRegistryStore = {
      listRegistryIDs: () => base.listRegistryIDs(),
      getState: (id) => base.getState(id),
      putState: (value) => base.putState(value),
      getSnapshot: (id, revision) => base.getSnapshot(id, revision),
      publishSnapshot: async (catalog, value) => {
        await base.publishSnapshot(catalog, value)
        if (failReadyState && value.status.state === 'ready') {
          failReadyState = false
          throw new Error('transient state response failure')
        }
      },
      putArtifact: (descriptor, bytes) => base.putArtifact(descriptor, bytes),
      getArtifact: (digest) => base.getArtifact(digest),
      putImage: (descriptor, bytes) => base.putImage(descriptor, bytes),
      getImage: (digest) => base.getImage(digest),
    }
    const definition: SkillRegistryDefinition = {
      schema_version: '1', id: 'memoh', name: 'Memoh', enabled: true, priority: 100,
      adapter: 'skill_directory', source: { type: 'local', path: 'skills' }, refresh_interval_seconds: 43_200,
      retention: { snapshots: 30 },
    }
    const result = await new SkillRegistryRefresher(store, projectRoot).refresh(definition)
    expect(result.skills).toBe(1)
    const catalog = await snapshot(base, 'memoh')
    expect((await state(base, 'memoh'))).toMatchObject({ current_snapshot: catalog?.revision, status: { state: 'ready' } })
  })
})
