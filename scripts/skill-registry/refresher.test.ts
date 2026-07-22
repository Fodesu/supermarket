import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { SkillRegistryDefinition } from '../../server/types/skill-registry'
import { LocalSkillRegistryStore } from '../../server/utils/local-skill-registry-store'
import { SkillRegistryRefresher } from './refresher'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

async function writeSkill(projectRoot: string, id: string, version: string) {
  const directory = path.join(projectRoot, 'skills', id)
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${id}\ndescription: Version ${version}\n---\n\n# ${id}\n`)
}

describe('SkillRegistryRefresher', () => {
  test('publishes ready artifacts, supports scoped refresh and preserves last-known-good', async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'skill-refresher-project-'))
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'skill-refresher-data-'))
    roots.push(projectRoot, dataRoot)
    await writeSkill(projectRoot, 'alpha', '1')
    await writeSkill(projectRoot, 'beta', '1')
    const definition: SkillRegistryDefinition = {
      schema_version: '1', id: 'memoh', name: 'Memoh', enabled: true, priority: 100,
      adapter: 'skill_directory', source: { type: 'local', path: 'skills' }, refresh_interval_seconds: 43_200,
    }
    const store = new LocalSkillRegistryStore(dataRoot)
    const refresher = new SkillRegistryRefresher(store, projectRoot)

    const first = await refresher.refresh(definition)
    expect(first.skills).toBe(2)
    const initial = await store.getCatalog('memoh')
    expect(initial?.skills.every((skill) => skill.artifact.format === 'memoh_skill_v1')).toBe(true)
    for (const skill of initial!.skills) expect(await store.getArtifact(skill.artifact.digest)).not.toBeNull()

    expect(await refresher.refresh(definition)).toMatchObject({ revision: initial?.revision, skipped: 'unchanged' })
    const forced = await refresher.refresh(definition, { force: true })
    expect(forced.revision).not.toBe(initial?.revision)

    await writeSkill(projectRoot, 'alpha', '2')
    await refresher.refresh(definition, { package: 'alpha', skill: 'alpha' })
    const updated = await store.getCatalog('memoh')
    expect(updated?.skills).toHaveLength(2)
    expect(updated?.skills.find((skill) => skill.skill_id === 'alpha')?.description).toBe('Version 2')
    expect(updated?.skills.find((skill) => skill.skill_id === 'beta')?.description).toBe('Version 1')

    await writeFile(path.join(projectRoot, 'skills/alpha/SKILL.md'), '# invalid')
    await expect(refresher.refresh(definition, { package: 'alpha' })).rejects.toThrow('frontmatter')
    expect((await store.getCatalog('memoh'))?.revision).toBe(updated?.revision)
    expect((await store.getStatus('memoh'))?.state).toBe('stale')
  })
})
