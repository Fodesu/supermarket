import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { SkillRegistryDefinition } from '../../server/types/skill-registry'
import { buildSkillCandidates } from './adapters'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

async function writeSkill(root: string, relativePath: string, name: string, extra = '') {
  const directory = path.join(root, relativePath)
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} description\nmetadata:\n  tags: [test]\n---\n\n# ${name}\n`)
  if (extra) await writeFile(path.join(directory, 'reference.md'), extra)
}

function definition(adapter: SkillRegistryDefinition['adapter']): SkillRegistryDefinition {
  return {
    schema_version: '1', id: 'example', name: 'Example', enabled: true, priority: 10, adapter,
    source: { type: 'local', path: 'source' }, catalog_path: adapter === 'codex_marketplace_skills' ? 'marketplace.json' : undefined,
    refresh_interval_seconds: 43_200, defaults: { runtime_requirements: { os: ['darwin', 'linux', 'win32'] } },
  }
}

describe('Skill Registry adapters', () => {
  test('imports standalone skill directories', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'standalone-skills-'))
    roots.push(root)
    await writeSkill(root, 'alpha', 'Alpha', 'reference')
    await mkdir(path.join(root, 'notes'))
    const result = await buildSkillCandidates({ definition: definition('skill_directory'), sourceRoot: root })
    expect(result.diagnostics).toEqual([])
    expect(result.skills).toHaveLength(1)
    expect(result.skills[0]).toMatchObject({
      package_id: 'alpha', skill_id: 'alpha', install_id: 'example+alpha+alpha',
      name: 'Alpha', description: 'Alpha description', tags: ['test'],
    })
    expect(Object.keys(result.skills[0]!.files).sort()).toEqual(['SKILL.md', 'reference.md'])
  })

  test('flattens Codex package skills and skips packages with runtime components', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codex-skills-'))
    roots.push(root)
    await mkdir(path.join(root, 'packages/usable/.codex-plugin'), { recursive: true })
    await mkdir(path.join(root, 'packages/blocked/.codex-plugin'), { recursive: true })
    await writeFile(path.join(root, 'marketplace.json'), JSON.stringify({ plugins: [
      { name: 'usable', category: 'Developer Tools', source: { source: 'local', path: 'packages/usable' } },
      { name: 'blocked', source: { source: 'local', path: 'packages/blocked' } },
    ] }))
    await writeFile(path.join(root, 'packages/usable/.codex-plugin/plugin.json'), JSON.stringify({
      name: 'usable', author: { name: 'OpenAI' }, keywords: ['codex'], skills: './skills',
    }))
    await writeFile(path.join(root, 'packages/blocked/.codex-plugin/plugin.json'), JSON.stringify({
      name: 'blocked', skills: './skills', mcpServers: { example: { url: 'https://example.test' } },
    }))
    await writeSkill(root, 'packages/usable/skills/demo', 'Demo')
    await writeSkill(root, 'packages/blocked/skills/blocked', 'Blocked')

    const result = await buildSkillCandidates({
      definition: definition('codex_marketplace_skills'), sourceRoot: root,
    })
    expect(result.skills).toHaveLength(1)
    expect(result.skills[0]).toMatchObject({
      package_id: 'usable', skill_id: 'demo', category: 'developer-tools',
      author: { name: 'OpenAI', email: '' }, tags: ['test', 'codex'],
    })
    expect(result.diagnostics).toEqual([{
      package_id: 'blocked', code: 'source_requires_runtime_components',
      message: 'Skipped package because it declares: mcpServers',
    }])
  })

  test('requires package scope for single-skill refreshes', async () => {
    expect(() => buildSkillCandidates({
      definition: definition('skill_directory'), sourceRoot: '.', skillFilter: 'demo',
    })).toThrow('--skill requires --package')
  })

  test('rejects duplicate Marketplace package identities', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codex-duplicate-packages-'))
    roots.push(root)
    await writeFile(path.join(root, 'marketplace.json'), JSON.stringify({ plugins: [
      { name: 'duplicate', source: 'packages/one' },
      { name: 'duplicate', source: 'packages/two' },
    ] }))
    await expect(buildSkillCandidates({
      definition: definition('codex_marketplace_skills'), sourceRoot: root,
    })).rejects.toThrow('duplicate package ID')
  })
})
