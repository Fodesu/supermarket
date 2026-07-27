import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { SkillRegistryDefinition } from '../../server/types/skill-registry'
import { LocalSkillRegistryStore } from '../../server/utils/local-skill-registry-store'
import type { SkillRegistryStore } from '../../server/utils/skill-registry-store'
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

describe('SkillRegistryRefresher', () => {
  test('uses each Registry refresh interval to determine whether it is due', () => {
    const definition: SkillRegistryDefinition = {
      schema_version: '1', id: 'memoh', name: 'Memoh', enabled: true, priority: 100,
      adapter: 'skill_directory', source: { type: 'local', path: 'skills' }, refresh_interval_seconds: 7_200,
      retention: { catalog_revisions: 30 },
    }
    const lastSuccess = '2026-01-01T00:00:00.000Z'
    expect(isSkillRegistryRefreshDue(definition, { registry_id: 'memoh', state: 'ready', last_success_at: lastSuccess }, Date.parse('2026-01-01T01:59:59.000Z'))).toBe(false)
    expect(isSkillRegistryRefreshDue(definition, { registry_id: 'memoh', state: 'ready', last_success_at: lastSuccess }, Date.parse('2026-01-01T02:00:00.000Z'))).toBe(true)
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
      retention: { catalog_revisions: 30 },
    }
    const store = new LocalSkillRegistryStore(dataRoot)
    const refresher = new SkillRegistryRefresher(store, projectRoot)

    await expect(refresher.refresh(definition, { package: 'alpha' }))
      .rejects.toThrow('scoped refresh requires an existing Catalog')
    expect(await store.getCatalog('memoh')).toBeNull()

    const first = await refresher.refresh(definition)
    expect(first.skills).toBe(2)
    const initial = await store.getCatalog('memoh')
    expect(initial?.skills.every((skill) => skill.artifact.format === 'memoh_skill_v1')).toBe(true)
    for (const skill of initial!.skills) expect(await store.getArtifact(skill.artifact.digest)).not.toBeNull()

    const overlapping = refresher.refresh(definition)
    await expect(refresher.refresh(definition)).rejects.toThrow('another refresh is already running')
    await overlapping

    await Bun.sleep(5)
    expect(await refresher.refresh(definition)).toMatchObject({ revision: initial?.revision, skipped: 'unchanged' })
    const unchangedStatus = await store.getStatus('memoh')
    expect(Date.parse(unchangedStatus!.last_success_at!)).toBeGreaterThan(Date.parse(initial!.synced_at))
    const forced = await refresher.refresh(definition, { force: true })
    expect(forced.revision).not.toBe(initial?.revision)

    await writeSkill(projectRoot, 'alpha', '2')
    await refresher.refresh(definition, { package: 'alpha', skill: 'alpha' })
    const updated = await store.getCatalog('memoh')
    expect(updated?.skills).toHaveLength(2)
    expect(updated?.skills.find((skill) => skill.skill_id === 'alpha')?.description).toBe('Version 2')
    expect(updated?.skills.find((skill) => skill.skill_id === 'beta')?.description).toBe('Version 1')

    await expect(refresher.refresh({ ...definition, priority: 101 }, { package: 'alpha' }))
      .rejects.toThrow('unchanged Registry definition')
    expect((await store.getDefinition('memoh'))?.priority).toBe(100)

    await rm(path.join(projectRoot, 'skills/beta'), { recursive: true })
    await refresher.refresh(definition, { package: 'beta' })
    expect((await store.getCatalog('memoh'))?.skills.map((skill) => skill.skill_id)).toEqual(['alpha'])
    await expect(refresher.refresh(definition, { package: 'missing' })).rejects.toThrow('not found')

    await writeFile(path.join(projectRoot, 'skills/alpha/SKILL.md'), '# invalid')
    const beforeFailure = await store.getCatalog('memoh')
    const lastSuccessAt = (await store.getStatus('memoh'))?.last_success_at
    await expect(refresher.refresh({ ...definition, priority: 101 })).rejects.toThrow('frontmatter')
    expect((await store.getDefinition('memoh'))?.priority).toBe(100)
    await expect(refresher.refresh(definition, { package: 'alpha' })).rejects.toThrow('frontmatter')
    expect((await store.getCatalog('memoh'))?.revision).toBe(beforeFailure?.revision)
    expect((await store.getStatus('memoh'))?.state).toBe('stale')
    expect((await store.getStatus('memoh'))?.last_success_at).toBe(lastSuccessAt)
  })

  test('skips Git registries whose upstream revision is already verified', async () => {
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
      refresh_interval_seconds: 43_200, retention: { catalog_revisions: 30 },
    }
    const store = new LocalSkillRegistryStore(dataRoot)
    const events: SkillRegistryRefreshProgress[] = []
    const refresher = new SkillRegistryRefresher(store, projectRoot, undefined, (event) => events.push(event))

    const first = await refresher.refresh(definition)
    expect(first.skills).toBe(1)
    const firstStatus = await store.getStatus('gitreg')
    expect(firstStatus?.last_source_revision).toMatch(/^[a-f0-9]{40}$/)

    // Status provenance is only valid for the Catalog revision it describes.
    // A stale or manually rolled-back pointer must force a full verification.
    await store.putStatus({ ...firstStatus!, current_revision: 'f'.repeat(64) })
    events.length = 0
    expect(await refresher.refresh(definition)).toMatchObject({ revision: first.revision, skipped: 'unchanged' })
    expect(events.map((event) => event.type)).toContain('source')
    expect(events.map((event) => event.type)).not.toContain('source_unchanged')

    // Unchanged upstream: one ls-remote, no clone, no Catalog work.
    events.length = 0
    expect(await refresher.refresh(definition)).toMatchObject({ revision: first.revision, skipped: 'source_unchanged' })
    expect(events.map((event) => event.type)).toEqual(['source_unchanged'])
    expect(Date.parse((await store.getStatus('gitreg'))!.last_success_at!))
      .toBeGreaterThanOrEqual(Date.parse(firstStatus!.last_success_at!))

    // An upstream commit that touches no Skill: the full pass runs, but the
    // provenance-free content revision keeps the Catalog revision stable.
    await writeFile(path.join(repository, 'README.md'), 'docs only')
    await git('add', '.')
    await git('commit', '-m', 'docs')
    expect(await refresher.refresh(definition)).toMatchObject({ revision: first.revision, skipped: 'unchanged' })
    const afterDocs = await store.getStatus('gitreg')
    expect(afterDocs?.last_source_revision).toMatch(/^[a-f0-9]{40}$/)
    expect(afterDocs?.last_source_revision).not.toBe(firstStatus?.last_source_revision)

    // The docs-only revision is now verified, so the fast path re-arms.
    expect(await refresher.refresh(definition)).toMatchObject({ revision: first.revision, skipped: 'source_unchanged' })

    // A definition change must bypass the fast path even with an unchanged source.
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
    expect((await store.getCatalog('gitreg'))?.skills[0]?.description).toBe('Two')
  })

  test('reports progress for uploads, cache hits, and skipped publications', async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'skill-progress-project-'))
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'skill-progress-data-'))
    roots.push(projectRoot, dataRoot)
    await writeSkill(projectRoot, 'alpha', '1')
    const definition: SkillRegistryDefinition = {
      schema_version: '1', id: 'memoh', name: 'Memoh', enabled: true, priority: 100,
      adapter: 'skill_directory', source: { type: 'local', path: 'skills' }, refresh_interval_seconds: 43_200,
      retention: { catalog_revisions: 30 },
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
    let failReadyStatus = true
    const store: SkillRegistryStore = {
      listRegistryIDs: () => base.listRegistryIDs(),
      getDefinition: (id) => base.getDefinition(id),
      putDefinition: (value) => base.putDefinition(value),
      getCatalog: (id) => base.getCatalog(id),
      publishCatalog: (catalog) => base.publishCatalog(catalog),
      getStatus: (id) => base.getStatus(id),
      putStatus: async (status) => {
        if (failReadyStatus && status.state === 'ready') {
          failReadyStatus = false
          throw new Error('transient status failure')
        }
        await base.putStatus(status)
      },
      putArtifact: (descriptor, bytes) => base.putArtifact(descriptor, bytes),
      getArtifact: (digest) => base.getArtifact(digest),
    }
    const definition: SkillRegistryDefinition = {
      schema_version: '1', id: 'memoh', name: 'Memoh', enabled: true, priority: 100,
      adapter: 'skill_directory', source: { type: 'local', path: 'skills' }, refresh_interval_seconds: 43_200,
      retention: { catalog_revisions: 30 },
    }
    const result = await new SkillRegistryRefresher(store, projectRoot).refresh(definition)
    expect(result.skills).toBe(1)
    const catalog = await base.getCatalog('memoh')
    expect(await base.getStatus('memoh')).toMatchObject({ state: 'ready', current_revision: catalog?.revision })
  })
})
