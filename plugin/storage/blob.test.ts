import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { sha256 } from '#registry/digest'
import { serializePluginRelease } from '../release'
import type { PluginArtifactDescriptor, PluginRelease } from '../types'
import { LocalPluginReleaseStore } from './local'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'plugin-store-'))
  roots.push(root)
  const store = new LocalPluginReleaseStore(root)
  const bytes = new TextEncoder().encode('plugin artifact')
  const artifact: PluginArtifactDescriptor = {
    format: 'memoh_plugin_v1', digest: await sha256(bytes), size: bytes.length,
    content_type: 'application/gzip',
  }
  const release: PluginRelease = {
    schema_version: '1',
    plugin: {
      schema_version: '1', id: 'example', name: 'Example', version: '1.0.0',
      description: 'Example Plugin', author: { name: 'Memoh', email: '' },
    },
    artifact,
    skills: [],
  }
  return { store, bytes, artifact, release, releaseBytes: serializePluginRelease(release) }
}

describe('PluginReleaseStore contract', () => {
  test('stores immutable releases and Artifacts before switching current state', async () => {
    const { store, bytes, artifact, release, releaseBytes } = await fixture()
    expect(await store.putArtifact(artifact, bytes)).toEqual({ stored: true })
    expect(await store.putArtifact(artifact, bytes)).toEqual({ stored: false })
    const revision = await store.publishRelease(releaseBytes, 'example', {
      publishedAt: '2026-08-01T00:00:00.000Z',
    })
    expect(await store.listPluginIDs()).toEqual(['example'])
    expect(await store.getState('example')).toMatchObject({
      enabled: true, current_release: revision,
      current_summary: { revision, published_at: '2026-08-01T00:00:00.000Z' },
    })
    expect(await store.getReleaseBytes('example', revision)).toEqual(releaseBytes)
    expect(await store.getRelease('example', revision)).toEqual(release)
    const storedArtifact = await store.getArtifactStream(artifact.digest)
    expect(storedArtifact?.descriptor).toEqual(artifact)
    expect(new Uint8Array(await new Response(storedArtifact!.body).arrayBuffer())).toEqual(bytes)
  })

  test('rejects Artifact metadata that does not match bytes', async () => {
    const { store, bytes, artifact } = await fixture()
    await expect(store.putArtifact({ ...artifact, digest: 'a'.repeat(64) }, bytes))
      .rejects.toThrow('does not match')
    expect(await store.getState('example')).toBeNull()
  })
})
