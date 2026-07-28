import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { SkillRegistryAdapter, SkillRegistryDefinition } from '../types'
import { readDirectoryFiles } from '../filesystem'
import { buildSkillCandidates } from './index'
import { detectSkillImageContentType } from './codex-marketplace'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

async function writeSkill(root: string, relativePath: string, name: string, extra = '') {
  const directory = path.join(root, relativePath)
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} description\nmetadata:\n  tags: [test]\n---\n\n# ${name}\n`)
  if (extra) await writeFile(path.join(directory, 'reference.md'), extra)
}

function definition(adapterType: SkillRegistryAdapter['type']): SkillRegistryDefinition {
  const adapter: SkillRegistryAdapter = adapterType === 'codex_marketplace_skills'
    ? { type: adapterType, catalog_path: 'marketplace.json' }
    : { type: adapterType }
  return {
    schema_version: '1', id: 'example', name: 'Example', enabled: true, priority: 10, adapter,
    source: { type: 'local', path: 'source' },
    refresh_interval_seconds: 43_200, retention: { snapshots: 30 },
  }
}

describe('Skill Registry adapters', () => {
  test('imports standalone skill directories', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'standalone-skills-'))
    roots.push(root)
    await writeSkill(root, 'alpha', 'Alpha', 'reference')
    await writeFile(path.join(root, 'alpha/run.sh'), '#!/bin/sh\n')
    await chmod(path.join(root, 'alpha/run.sh'), 0o755)
    await mkdir(path.join(root, 'notes'))
    const result = await buildSkillCandidates({ definition: definition('skill_directory'), sourceRoot: root })
    expect(result.diagnostics).toEqual([])
    expect(result.skills).toHaveLength(1)
    expect(result.skills[0]).toMatchObject({
      package_id: 'alpha', skill_id: 'alpha', install_id: 'example+alpha+alpha',
      name: 'Alpha', description: 'Alpha description', tags: ['test'],
    })
    expect(Object.keys(result.skills[0]!.files).sort()).toEqual(['SKILL.md', 'reference.md', 'run.sh'])
    expect(result.skills[0]!.files['run.sh']?.mode).toBe(0o755)
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
      interface: {
        composerIcon: './assets/icon.svg', logo: './assets/logo.png', brandColor: '#0b7285',
      },
    }))
    await mkdir(path.join(root, 'packages/usable/assets'), { recursive: true })
    await writeFile(path.join(root, 'packages/usable/assets/icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    await writeFile(path.join(root, 'packages/usable/assets/logo.png'), new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]))
    await writeFile(path.join(root, 'packages/blocked/.codex-plugin/plugin.json'), JSON.stringify({
      name: 'blocked', skills: './skills', apps: ['./app'],
      mcpServers: { example: { url: 'https://example.test' } }, hooks: { sessionStart: ['./hook'] },
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
      icon: {
        card: { content_type: 'image/svg+xml' }, detail: { content_type: 'image/png' }, brand_color: '#0B7285',
      },
    })
    expect(result.skills[0]!.icon_assets).toHaveLength(2)
    expect(result.diagnostics).toEqual([{
      package_id: 'blocked', code: 'source_requires_runtime_components',
      message: 'Skipped package because it declares: apps, mcpServers, hooks',
    }])
  })

  test('identifies image MIME from bytes and rejects mislabeled images', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(detectSkillImageContentType(png)).toBe('image/png')
    expect(detectSkillImageContentType(new TextEncoder().encode(
      '<?xml version="1.0"?><!-- icon --><svg xmlns="http://www.w3.org/2000/svg"/>',
    ))).toBe('image/svg+xml')

    const root = await mkdtemp(path.join(os.tmpdir(), 'codex-mislabeled-image-'))
    roots.push(root)
    await mkdir(path.join(root, 'packages/demo/.codex-plugin'), { recursive: true })
    await mkdir(path.join(root, 'packages/demo/assets'), { recursive: true })
    await writeFile(path.join(root, 'marketplace.json'), JSON.stringify({ plugins: [
      { name: 'demo', source: 'packages/demo' },
    ] }))
    await writeFile(path.join(root, 'packages/demo/.codex-plugin/plugin.json'), JSON.stringify({
      name: 'demo', skills: './skills', interface: { logo: './assets/logo.webp' },
    }))
    await writeFile(path.join(root, 'packages/demo/assets/logo.webp'), png)
    await writeSkill(root, 'packages/demo/skills/demo', 'Demo')

    await expect(buildSkillCandidates({
      definition: definition('codex_marketplace_skills'), sourceRoot: root,
    })).rejects.toThrow('content does not match its file extension')
  })

  test('requires package scope for single-skill refreshes', async () => {
    expect(() => buildSkillCandidates({
      definition: definition('skill_directory'), sourceRoot: '.', skillFilter: 'demo',
    })).toThrow('--skill requires --package')
  })

  test('requires package scope when a Marketplace package was removed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codex-removed-package-'))
    roots.push(root)
    await writeFile(path.join(root, 'marketplace.json'), JSON.stringify({ plugins: [] }))
    await expect(buildSkillCandidates({
      definition: definition('codex_marketplace_skills'), sourceRoot: root,
      packageFilter: 'removed', skillFilter: 'skill', allowMissingScope: true,
    })).rejects.toThrow('refresh the whole package')
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

  test('rejects skill roots that escape through symlinks', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skill-symlink-source-'))
    const outside = await mkdtemp(path.join(os.tmpdir(), 'skill-symlink-outside-'))
    roots.push(root, outside)
    await writeSkill(outside, '.', 'Outside')
    await symlink(outside, path.join(root, 'escaped'))
    await expect(buildSkillCandidates({ definition: definition('skill_directory'), sourceRoot: root }))
      .resolves.toEqual({ skills: [], diagnostics: [] })

    await mkdir(path.join(root, 'package'), { recursive: true })
    await symlink(outside, path.join(root, 'package/escaped'))
    await expect(readDirectoryFiles(path.join(root, 'package/escaped'), root)).rejects.toThrow('escapes source')
  })

  test('normalizes scalar author and tag metadata', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skill-scalar-metadata-'))
    roots.push(root)
    await mkdir(path.join(root, 'demo'), { recursive: true })
    await writeFile(path.join(root, 'demo/SKILL.md'), `---\nname: Demo\ndescription: Demo\nmetadata:\n  author: Demo Team <demo@example.com>\n  tags: docs, reports\n---\n`)
    const result = await buildSkillCandidates({ definition: definition('skill_directory'), sourceRoot: root })
    expect(result.skills[0]).toMatchObject({
      author: { name: 'Demo Team', email: 'demo@example.com' }, tags: ['docs', 'reports'],
    })
  })
})
