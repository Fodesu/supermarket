import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { SkillRegistryDefinition } from '../types'
import { buildSkillCandidates } from '../adapters/index'
import { materializeSkillRegistrySource } from './index'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

async function git(cwd: string, ...args: string[]) {
  const child = Bun.spawn(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited])
  if (exitCode !== 0) throw new Error(stderr)
}

async function revParseHead(cwd: string) {
  const child = Bun.spawn(['git', '-C', cwd, 'rev-parse', 'HEAD'], { stdout: 'pipe', stderr: 'pipe' })
  return (await new Response(child.stdout).text()).trim()
}

describe('Skill Registry Git sources', () => {
  test('fetches one revision and expands sparse Marketplace paths on demand', async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), 'skill-source-repository-'))
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'skill-source-project-'))
    roots.push(repository, projectRoot)
    await git(repository, 'init', '-b', 'main')
    await git(repository, 'config', 'user.email', 'test@example.com')
    await git(repository, 'config', 'user.name', 'Test')
    await mkdir(path.join(repository, 'plugins/demo/.codex-plugin'), { recursive: true })
    await mkdir(path.join(repository, 'plugins/demo/skills/example'), { recursive: true })
    await writeFile(path.join(repository, 'marketplace.json'), JSON.stringify({
      plugins: [{ name: 'demo', source: { source: 'local', path: 'plugins/demo' } }],
    }))
    await writeFile(path.join(repository, 'plugins/demo/.codex-plugin/plugin.json'), JSON.stringify({
      name: 'demo', skills: './skills',
    }))
    await writeFile(path.join(repository, 'plugins/demo/skills/example/SKILL.md'), '---\nname: Example\ndescription: Example\n---\n')
    await git(repository, 'add', '.')
    await git(repository, 'commit', '-m', 'fixture')

    const definition: SkillRegistryDefinition = {
      schema_version: '1', id: 'example', name: 'Example', enabled: true, priority: 10,
      adapter: { type: 'codex_marketplace_skills', catalog_path: 'marketplace.json' },
      source: { type: 'git', url: repository, ref: 'main' }, refresh_interval_seconds: 43_200,
      retention: { snapshots: 30 },
    }
    const source = await materializeSkillRegistrySource(definition, projectRoot)
    try {
      expect(source.revision).toMatch(/^[a-f0-9]{40}$/)
      const result = await buildSkillCandidates({
        definition, sourceRoot: source.root, ensurePaths: source.ensurePaths,
      })
      expect(result.skills).toHaveLength(1)
      expect(result.skills[0]).toMatchObject({ package_id: 'demo', skill_id: 'example' })
    } finally {
      await source.cleanup()
    }

    expect(await revParseHead(repository)).toBe(source.revision)

    const before = new Set((await readdir(os.tmpdir())).filter((name) => name.startsWith('supermarket-skills-git-')))
    await expect(materializeSkillRegistrySource({
      ...definition, source: { ...definition.source, path: 'missing' },
    }, projectRoot)).rejects.toThrow()
    const after = (await readdir(os.tmpdir()))
      .filter((name) => name.startsWith('supermarket-skills-git-'))
    expect(after.filter((name) => !before.has(name))).toEqual([])
  })
})

describe('Skill Registry local sources', () => {
  test('resolves source paths relative to the Registry definition directory', async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'skill-source-project-'))
    roots.push(projectRoot)
    const sourceRoot = path.join(projectRoot, 'registries/example/skills')
    await mkdir(sourceRoot, { recursive: true })
    await writeFile(path.join(sourceRoot, 'README.md'), 'local Registry source')
    const definition: SkillRegistryDefinition = {
      schema_version: '1', id: 'example', name: 'Example', enabled: true, priority: 10,
      adapter: { type: 'skill_directory' },
      source: { type: 'local', path: 'skills' },
      refresh_interval_seconds: 43_200,
      retention: { snapshots: 30 },
    }

    const source = await materializeSkillRegistrySource(definition, projectRoot)
    expect(source.root).toBe(await realpath(sourceRoot))
    expect(source.revision).toMatch(/^[a-f0-9]{64}$/)
  })
})
