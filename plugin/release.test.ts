import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseGzipTarArchive } from '#client/archive'
import type { CatalogSkill, SkillRegistrySnapshot } from '#registry/types'
import {
  MAX_SKILL_ARTIFACT_ARCHIVE_BYTES,
  MAX_SKILL_ARTIFACT_COMPRESSED_BYTES,
  MAX_SKILL_ARTIFACT_FILES,
  MAX_SKILL_ARTIFACT_UNCOMPRESSED_BYTES,
} from '#registry/types'
import { compactCatalogSkill } from '#registry/snapshot'
import {
  assertPluginReleaseRevision,
  buildPluginReleaseCandidates,
  parsePluginRelease,
  serializePluginRelease,
} from './release'
import {
  MAX_PLUGIN_SKILL_ARTIFACTS_ARCHIVE_BYTES,
  MAX_PLUGIN_SKILL_ARTIFACTS_COMPRESSED_BYTES,
  MAX_PLUGIN_SKILL_ARTIFACTS_FILES,
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
    archive_size: 1_024,
    file_count: 1,
    content_type: 'application/gzip' as const,
  }
  const skill: CatalogSkill = {
    schema_version: '1', registry_id: 'example', registry_priority: 1,
    package_id: 'tools', skill_id: 'search', install_id: 'example+tools+search',
    name: 'Search', description: 'Search', author: { name: 'Test', email: '' },
    tags: ['search'], category: 'tools', category_name: 'Tools',
    runtime_requirements: { os: ['linux'] },
    source: { type: 'local', revision: 'e'.repeat(64), path: 'skills/search' },
    files: ['SKILL.md'], artifact,
  }
  const snapshot: SkillRegistrySnapshot = {
    schema_version: '1', registry_id: 'example', registry_priority: 1,
    source: { type: 'local', revision: 'e'.repeat(64) },
    skills: [compactCatalogSkill(skill)], diagnostics: [],
  }
  return { root, snapshot }
}

function releaseWithSkills(count: number, artifactOverrides: Partial<PluginRelease['skills'][number]['artifact']> = {}): PluginRelease {
  const references = Array.from({ length: count }, (_, index) => ({
    registry_id: 'example', package_id: 'tools', skill_id: `skill-${index}`,
  }))
  return {
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
      source_revision: 'd'.repeat(64),
      install_id: `${reference.registry_id}+${reference.package_id}+${reference.skill_id}`,
      artifact: {
        format: 'memoh_skill_v1', digest: 'c'.repeat(64), size: 1,
        uncompressed_size: 1, archive_size: 1, file_count: 1,
        content_type: 'application/gzip',
        ...artifactOverrides,
      },
    })),
  }
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
      registry_revision: 'b'.repeat(64), source_revision: 'e'.repeat(64),
      install_id: 'example+tools+search', artifact: { digest: 'a'.repeat(64) },
      runtime_requirements: { os: ['linux'] },
    })
    expect(candidate!.release.skills[0]!.artifact).toMatchObject({
      uncompressed_size: 456, archive_size: 1_024, file_count: 1,
    })
    const releaseBytes = serializePluginRelease(candidate!.release)
    expect(parsePluginRelease(releaseBytes, 'example')).toEqual(candidate!.release)
    await expect(assertPluginReleaseRevision(releaseBytes, candidate!.revision)).resolves.toBeUndefined()

    const files = await parseGzipTarArchive(candidate!.artifact_bytes)
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
    expect(after!.release.artifact.digest).toBe(before!.release.artifact.digest)
  })

  test('rejects a missing referenced Skill', async () => {
    const { root, snapshot } = await fixture()
    snapshot.skills = []
    await expect(buildPluginReleaseCandidates(root, [{ revision: 'b'.repeat(64), snapshot }]))
      .rejects.toThrow('references missing Registry Skill')
  })

  test('rejects releases whose Skill Artifacts exceed the Memoh install budgets', () => {
    expect(() => parsePluginRelease(serializePluginRelease(releaseWithSkills(26, {
      uncompressed_size: MAX_SKILL_ARTIFACT_UNCOMPRESSED_BYTES,
    })), 'example'))
      .toThrow(`${MAX_PLUGIN_SKILL_ARTIFACTS_UNCOMPRESSED_BYTES} byte uncompressed limit`)
    expect(() => parsePluginRelease(serializePluginRelease(releaseWithSkills(22, {
      size: MAX_SKILL_ARTIFACT_COMPRESSED_BYTES,
    })), 'example'))
      .toThrow(`${MAX_PLUGIN_SKILL_ARTIFACTS_COMPRESSED_BYTES} byte compressed limit`)
    expect(() => parsePluginRelease(serializePluginRelease(releaseWithSkills(26, {
      archive_size: MAX_SKILL_ARTIFACT_ARCHIVE_BYTES,
    })), 'example'))
      .toThrow(`${MAX_PLUGIN_SKILL_ARTIFACTS_ARCHIVE_BYTES} byte archive limit`)
    expect(() => parsePluginRelease(serializePluginRelease(releaseWithSkills(11, {
      file_count: MAX_SKILL_ARTIFACT_FILES,
    })), 'example'))
      .toThrow(`${MAX_PLUGIN_SKILL_ARTIFACTS_FILES} file limit`)
  })

  test('rejects Skill Artifact descriptors without extraction metadata', () => {
    const release = releaseWithSkills(1)
    delete (release.skills[0]!.artifact as Partial<typeof release.skills[0]['artifact']>).archive_size
    expect(() => parsePluginRelease(serializePluginRelease(release), 'example'))
      .toThrow('invalid Skill Artifact')
  })

  test('rejects different descriptors for the same Skill Artifact digest', () => {
    const release = releaseWithSkills(2)
    release.skills[1]!.artifact.uncompressed_size = 2
    expect(() => parsePluginRelease(serializePluginRelease(release), 'example'))
      .toThrow('contains inconsistent descriptors for Skill Artifact')
  })

  test('rejects malformed source revisions and non-canonical install identities', () => {
    const malformedSource = releaseWithSkills(1)
    ;(malformedSource.skills[0] as unknown as { source_revision: number }).source_revision = 42
    expect(() => parsePluginRelease(serializePluginRelease(malformedSource), 'example'))
      .toThrow('contains an invalid Skill lock')

    const wrongInstallID = releaseWithSkills(1)
    wrongInstallID.skills[0]!.install_id = 'example+tools+different'
    expect(() => parsePluginRelease(serializePluginRelease(wrongInstallID), 'example'))
      .toThrow('contains an invalid Skill lock')
  })
})
