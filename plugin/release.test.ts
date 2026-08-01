import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseGzipTarArchive } from '#client/archive'
import type { CatalogSkill, SkillRegistrySnapshot } from '#registry/types'
import { compactCatalogSkill } from '#registry/snapshot'
import {
  assertPluginReleaseRevision,
  buildPluginReleaseCandidates,
  parsePluginRelease,
  serializePluginRelease,
} from './release'
import {
  MAX_PLUGIN_SKILL_ARTIFACTS_UNCOMPRESSED_BYTES,
  type PluginRelease,
} from './types'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'plugin-release-'))
  roots.push(root)
  const pluginRoot = path.join(root, 'registries/memoh/plugins/example')
  await mkdir(path.join(pluginRoot, 'scripts'), { recursive: true })
  await writeFile(path.join(pluginRoot, 'plugin.yaml'), [
    'schema_version: "1"', 'id: example', 'name: Example', 'version: 1.0.0',
    'description: Example Plugin', 'author:', '  name: Memoh', 'skills:',
    '  - registry_id: example', '    package_id: tools', '    skill_id: search',
  ].join('\n'))
  await writeFile(path.join(pluginRoot, 'scripts/run.sh'), '#!/bin/sh\n', { mode: 0o755 })
  await writeFile(path.join(pluginRoot, 'release.lock.json'), '{}\n')
  const artifact = {
    format: 'memoh_skill_v1' as const,
    digest: 'a'.repeat(64),
    size: 123,
    uncompressed_size: 456,
    content_type: 'application/gzip' as const,
  }
  const skill: CatalogSkill = {
    schema_version: '1', registry_id: 'example', registry_priority: 1,
    package_id: 'tools', skill_id: 'search', install_id: 'example+tools+search',
    name: 'Search', description: 'Search', author: { name: 'Test', email: '' },
    tags: ['search'], category: 'tools', category_name: 'Tools',
    runtime_requirements: { os: ['linux'] },
    source: { type: 'local', revision: 'source-revision', path: 'skills/search' },
    files: ['SKILL.md'], artifact,
  }
  const snapshot: SkillRegistrySnapshot = {
    schema_version: '1', registry_id: 'example', registry_priority: 1,
    source: { type: 'local', revision: 'source-revision' },
    skills: [compactCatalogSkill(skill)], diagnostics: [],
  }
  return { root, snapshot }
}

describe('Plugin release candidates', () => {
  test('packages only Plugin files and pins the approved Skill Artifact', async () => {
    const { root, snapshot } = await fixture()
    const [candidate] = await buildPluginReleaseCandidates(root, [{
      revision: 'b'.repeat(64), snapshot,
    }])
    expect(candidate).toBeDefined()
    expect(candidate!.release.skills[0]).toMatchObject({
      registry_id: 'example', package_id: 'tools', skill_id: 'search',
      registry_revision: 'b'.repeat(64), source_revision: 'source-revision',
      install_id: 'example+tools+search', artifact: { digest: 'a'.repeat(64) },
      runtime_requirements: { os: ['linux'] },
    })
    expect(parsePluginRelease(candidate!.releaseBytes, 'example')).toEqual(candidate!.release)
    await expect(assertPluginReleaseRevision(candidate!.releaseBytes, candidate!.revision)).resolves.toBeUndefined()

    const files = await parseGzipTarArchive(candidate!.artifact.bytes)
    expect([...files.keys()].sort()).toEqual(['example/plugin.yaml', 'example/scripts/run.sh'])
    expect(files.get('example/scripts/run.sh')?.mode).toBe(0o755)
    expect([...files.keys()].some((name) => name.includes('release.lock'))).toBeFalse()
  })

  test('changes release revision when a pinned Skill digest changes', async () => {
    const { root, snapshot } = await fixture()
    const [before] = await buildPluginReleaseCandidates(root, [{ revision: 'b'.repeat(64), snapshot }])
    snapshot.skills[0]!.artifact.digest = 'c'.repeat(64)
    const [after] = await buildPluginReleaseCandidates(root, [{ revision: 'd'.repeat(64), snapshot }])
    expect(after!.revision).not.toBe(before!.revision)
    expect(after!.artifact.descriptor.digest).toBe(before!.artifact.descriptor.digest)
  })

  test('rejects a missing referenced Skill', async () => {
    const { root, snapshot } = await fixture()
    snapshot.skills = []
    await expect(buildPluginReleaseCandidates(root, [{ revision: 'b'.repeat(64), snapshot }]))
      .rejects.toThrow('references missing Registry Skill')
  })

  test('rejects releases whose Skill Artifacts exceed the Memoh install budget', () => {
    const skillCount = 26
    const references = Array.from({ length: skillCount }, (_, index) => ({
      registry_id: 'example', package_id: 'tools', skill_id: `skill-${index}`,
    }))
    const release: PluginRelease = {
      schema_version: '1',
      plugin: {
        schema_version: '1', id: 'example', name: 'Example', version: '1.0.0',
        description: 'Example Plugin', author: { name: 'Memoh', email: '' }, skills: references,
      },
      artifact: {
        format: 'memoh_plugin_v1', digest: 'a'.repeat(64), size: 1,
        content_type: 'application/gzip',
      },
      skills: references.map((reference) => ({
        ...reference,
        registry_revision: 'b'.repeat(64),
        source_revision: 'source',
        install_id: `${reference.registry_id}+${reference.package_id}+${reference.skill_id}`,
        artifact: {
          format: 'memoh_skill_v1', digest: 'c'.repeat(64), size: 1,
          uncompressed_size: 5 * 1024 * 1024, content_type: 'application/gzip',
        },
      })),
    }

    expect(() => parsePluginRelease(serializePluginRelease(release), 'example'))
      .toThrow(`${MAX_PLUGIN_SKILL_ARTIFACTS_UNCOMPRESSED_BYTES} byte uncompressed limit`)
  })
})
