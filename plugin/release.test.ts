import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseGzipTarArchive } from '#client/archive'
import type { CatalogSkill, SkillRegistrySnapshot } from '#registry/types'
import { MAX_SKILL_ARTIFACT_UNCOMPRESSED_BYTES } from '#registry/types'
import { compactCatalogPackages } from '#registry/snapshot'
import {
  assertPluginReleaseRevision,
  buildPluginReleaseCandidates,
  parsePluginRelease,
  serializePluginRelease,
} from './release'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function skill(packageID: string, skillID: string, digest: string, uncompressedSize = 456): CatalogSkill {
  return {
    schema_version: '1', registry_id: 'example', registry_priority: 1,
    package_id: packageID, skill_id: skillID, install_id: `example+${packageID}+${skillID}`,
    name: skillID, description: skillID, author: { name: 'Test', email: '' },
    tags: [], category: 'tools', category_name: 'Tools',
    source: { type: 'local', revision: 'e'.repeat(64), path: `${packageID}/${skillID}` },
    files: ['SKILL.md'],
    artifact: {
      format: 'memoh_skill_v1', digest, size: 123,
      uncompressed_size: uncompressedSize, archive_size: 1_024, file_count: 1,
      content_type: 'application/gzip',
    },
  }
}

function snapshot(skills: CatalogSkill[]): SkillRegistrySnapshot {
  return {
    schema_version: '1', registry_id: 'example', registry_priority: 1,
    source: { type: 'local', revision: 'e'.repeat(64) },
    packages: compactCatalogPackages(skills), diagnostics: [],
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'plugin-release-'))
  roots.push(root)
  const pluginRoot = path.join(root, 'registries/memoh/plugins/example')
  await mkdir(path.join(pluginRoot, 'scripts'), { recursive: true })
  await writeFile(path.join(pluginRoot, 'plugin.yaml'), [
    'schema_version: "1"', 'id: example', 'name: Example', 'version: 1.0.0',
    'description: Example Plugin', 'author:', '  name: Memoh', 'packages:',
    '  - registry_id: example', '    package_id: tools',
  ].join('\n'))
  await writeFile(path.join(pluginRoot, 'scripts/run.sh'), '#!/bin/sh\n', { mode: 0o755 })
  await writeFile(path.join(pluginRoot, 'release.lock.json'), '{}\n')
  return {
    root,
    snapshot: snapshot([
      skill('tools', 'search', 'a'.repeat(64)),
      skill('other', 'other', 'b'.repeat(64)),
    ]),
  }
}

describe('Plugin release candidates', () => {
  test('packages only Plugin files and pins the approved Package release', async () => {
    const current = await fixture()
    const [candidate] = await buildPluginReleaseCandidates(current.root, [{
      revision: 'b'.repeat(64), snapshot: current.snapshot,
    }])
    const packageRevision = current.snapshot.packages.find(pkg => pkg.package_id === 'tools')!.revision
    expect(candidate!.release.packages).toEqual([{
      registry_id: 'example', package_id: 'tools', revision: packageRevision,
    }])
    const releaseBytes = serializePluginRelease(candidate!.release)
    expect(parsePluginRelease(releaseBytes, 'example')).toEqual(candidate!.release)
    await expect(assertPluginReleaseRevision(releaseBytes, candidate!.revision)).resolves.toBeUndefined()

    const files = await parseGzipTarArchive(candidate!.artifact_bytes)
    expect([...files.keys()].sort()).toEqual(['example/plugin.yaml', 'example/scripts/run.sh'])
    expect(files.get('example/scripts/run.sh')?.mode).toBe(0o755)
    expect([...files.keys()].some(name => name.includes('release.lock'))).toBeFalse()
  })

  test('changes only when a referenced Package changes', async () => {
    const current = await fixture()
    const [before] = await buildPluginReleaseCandidates(current.root, [{
      revision: 'b'.repeat(64), snapshot: current.snapshot,
    }])
    const unrelated = snapshot([
      skill('tools', 'search', 'a'.repeat(64)),
      skill('other', 'other', 'c'.repeat(64)),
    ])
    const [afterUnrelated] = await buildPluginReleaseCandidates(current.root, [{
      revision: 'c'.repeat(64), snapshot: unrelated,
    }])
    expect(afterUnrelated!.revision).toBe(before!.revision)

    const changed = snapshot([
      skill('tools', 'search', 'd'.repeat(64)),
      skill('other', 'other', 'c'.repeat(64)),
    ])
    const [afterReferenced] = await buildPluginReleaseCandidates(current.root, [{
      revision: 'd'.repeat(64), snapshot: changed,
    }])
    expect(afterReferenced!.revision).not.toBe(before!.revision)
    expect(afterReferenced!.release.artifact.digest).toBe(before!.release.artifact.digest)
  })

  test('rejects a missing referenced Package', async () => {
    const current = await fixture()
    current.snapshot.packages = []
    await expect(buildPluginReleaseCandidates(current.root, [{
      revision: 'b'.repeat(64), snapshot: current.snapshot,
    }])).rejects.toThrow('references missing Registry Package')
  })

  test('rejects Packages whose Skill Artifacts exceed the Plugin install budget', async () => {
    const current = await fixture()
    current.snapshot = snapshot(Array.from({ length: 26 }, (_, index) => skill(
      'tools', `skill-${index}`, `${index.toString(16).padStart(2, '0')}${'a'.repeat(62)}`,
      MAX_SKILL_ARTIFACT_UNCOMPRESSED_BYTES,
    )))
    await expect(buildPluginReleaseCandidates(current.root, [{
      revision: 'b'.repeat(64), snapshot: current.snapshot,
    }])).rejects.toThrow('Package Skill Artifacts exceed the Plugin install budget')
  })

  test('rejects malformed and reordered Package locks', async () => {
    const current = await fixture()
    const [candidate] = await buildPluginReleaseCandidates(current.root, [{
      revision: 'b'.repeat(64), snapshot: current.snapshot,
    }])
    candidate!.release.packages[0]!.revision = 'invalid'
    expect(() => parsePluginRelease(serializePluginRelease(candidate!.release), 'example')).toThrow()
    candidate!.release.packages[0] = {
      registry_id: 'example', package_id: 'other', revision: 'a'.repeat(64),
    }
    expect(() => parsePluginRelease(serializePluginRelease(candidate!.release), 'example'))
      .toThrow('Package lock order')
  })
})
