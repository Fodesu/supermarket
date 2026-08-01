import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { validateCommittedPlugins } from './repository'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'plugin-repository-'))
  roots.push(root)
  const pluginRoot = path.join(root, 'registries/memoh/plugins/example')
  await mkdir(pluginRoot, { recursive: true })
  await writeFile(path.join(pluginRoot, 'plugin.yaml'), [
    'schema_version: "1"',
    'id: example',
    'name: Example',
    'version: 1.0.0',
    'description: Example Plugin',
    'author:',
    '  name: Memoh',
  ].join('\n'))
  return { root, pluginRoot }
}

describe('Committed Plugin repository', () => {
  test('rejects symbolic links before build assets are collected', async () => {
    const { root, pluginRoot } = await repository()
    const outside = path.join(root, 'secret.txt')
    await writeFile(outside, 'secret')
    await symlink(outside, path.join(pluginRoot, 'secret.txt'))

    await expect(validateCommittedPlugins(root)).rejects.toThrow('must not contain symbolic links')
  })

  test('rejects symbolic links in the repository path before entering plugins', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'plugin-repository-parent-link-'))
    const outside = await mkdtemp(path.join(os.tmpdir(), 'plugin-repository-external-'))
    roots.push(root, outside)
    await mkdir(path.join(root, 'registries'), { recursive: true })
    await mkdir(path.join(outside, 'memoh/plugins/example'), { recursive: true })
    await writeFile(path.join(outside, 'memoh/plugins/example/plugin.yaml'), [
      'schema_version: "1"', 'id: example', 'name: Example', 'version: 1.0.0',
      'description: Example Plugin', 'author:', '  name: Memoh',
    ].join('\n'))
    await symlink(path.join(outside, 'memoh'), path.join(root, 'registries/memoh'))

    await expect(validateCommittedPlugins(root)).rejects.toThrow('registries/memoh')
  })

  test('rejects bundled Skill content', async () => {
    const { root, pluginRoot } = await repository()
    await mkdir(path.join(pluginRoot, 'skills/demo'), { recursive: true })
    await writeFile(path.join(pluginRoot, 'skills/demo/SKILL.md'), '---\nname: Demo\ndescription: Demo\n---\n')

    await expect(validateCommittedPlugins(root)).rejects.toThrow('must be published by a Registry')
  })

  test('rejects references missing from approved Registry candidates', async () => {
    const { root, pluginRoot } = await repository()
    await writeFile(path.join(pluginRoot, 'plugin.yaml'), [
      'schema_version: "1"', 'id: example', 'name: Example', 'version: 1.0.0',
      'description: Example Plugin', 'author:', '  name: Memoh', 'skills:',
      '  - registry_id: memoh', '    package_id: tools', '    skill_id: search',
    ].join('\n'))

    await expect(validateCommittedPlugins(root, new Set())).rejects.toThrow(
      'references missing Registry Skill: memoh/tools/search',
    )
    await expect(validateCommittedPlugins(root, new Set(['memoh/tools/search']))).resolves.toEqual(['example'])
  })
})
