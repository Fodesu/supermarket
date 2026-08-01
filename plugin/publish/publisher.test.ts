import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { sha256 } from '#registry/digest'
import type { PluginReleaseCandidate } from '../release'
import { pluginReleaseRevision, serializePluginRelease } from '../release'
import { LocalPluginReleaseStore } from '../storage/local'
import type { PluginArtifactDescriptor, PluginRelease } from '../types'
import { PluginReleasePublisher } from './publisher'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function candidate(version = '1.0.0'): Promise<PluginReleaseCandidate> {
  const bytes = new TextEncoder().encode(`plugin artifact ${version}`)
  const descriptor: PluginArtifactDescriptor = {
    format: 'memoh_plugin_v1', digest: await sha256(bytes), size: bytes.length,
    content_type: 'application/gzip',
  }
  const release: PluginRelease = {
    schema_version: '1',
    plugin: {
      schema_version: '1', id: 'example', name: 'Example', version,
      description: 'Example Plugin', author: { name: 'Memoh', email: '' },
    },
    artifact: descriptor,
    skills: [],
  }
  const releaseBytes = serializePluginRelease(release)
  return {
    plugin_id: 'example', revision: await pluginReleaseRevision(releaseBytes),
    release, releaseBytes, artifact: { descriptor, bytes },
  }
}

describe('PluginReleasePublisher', () => {
  test('requires an approved lock and preserves current on a rejected candidate', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'plugin-publisher-'))
    roots.push(root)
    const store = new LocalPluginReleaseStore(root)
    const publisher = new PluginReleasePublisher(store)
    const approved = await candidate()
    await expect(publisher.publish(approved)).rejects.toThrow('release.lock.json is required')
    await expect(publisher.publish(approved, { release_revision: 'a'.repeat(64) }))
      .rejects.toThrow('but the rebuilt release is')
    expect(await store.getState('example')).toBeNull()

    expect(await publisher.publish(approved, { release_revision: approved.revision }))
      .toMatchObject({ plugin: 'example', revision: approved.revision })
    const next = await candidate('2.0.0')
    await expect(publisher.publish(next, { release_revision: approved.revision }))
      .rejects.toThrow('but the rebuilt release is')
    expect((await store.getState('example'))?.current_release).toBe(approved.revision)
  })

  test('skips unchanged releases and disables removed Plugins without deleting releases', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'plugin-publisher-'))
    roots.push(root)
    const store = new LocalPluginReleaseStore(root)
    const publisher = new PluginReleasePublisher(store)
    const approved = await candidate()
    const lock = { release_revision: approved.revision }
    await publisher.publish(approved, lock)
    await rm(path.join(root, 'plugin-artifacts', `${approved.artifact.descriptor.digest}.tar.gz`))
    expect(await publisher.publish(approved, lock)).toMatchObject({ skipped: 'unchanged' })
    expect(await store.getArtifact(approved.artifact.descriptor.digest)).not.toBeNull()
    expect(await publisher.disable('example')).toMatchObject({ skipped: 'disabled' })
    expect((await store.getState('example'))?.enabled).toBeFalse()
    expect(await store.getRelease('example', approved.revision)).toEqual(approved.release)
  })

  test('derives approval from canonical release bytes and verifies the packaged Artifact', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'plugin-publisher-'))
    roots.push(root)
    const store = new LocalPluginReleaseStore(root)
    const publisher = new PluginReleasePublisher(store)
    const approved = await candidate()
    const lock = { release_revision: approved.revision }

    const changedRelease: PluginRelease = {
      ...approved.release,
      plugin: { ...approved.release.plugin, version: '9.0.0' },
    }
    await expect(publisher.publish({
      ...approved,
      releaseBytes: serializePluginRelease(changedRelease),
    }, lock)).rejects.toThrow('but the rebuilt release is')

    await expect(publisher.publish({
      ...approved,
      artifact: {
        ...approved.artifact,
        bytes: new TextEncoder().encode('different artifact'),
      },
    }, lock)).rejects.toThrow('Artifact does not match its content')
    expect(await store.getState('example')).toBeNull()
  })
})
