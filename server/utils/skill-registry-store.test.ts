import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MAX_SKILL_ARTIFACT_COMPRESSED_BYTES } from '../types/skill-registry'
import type { SkillArtifactDescriptor, SkillImageAsset, SkillRegistryCatalog, SkillRegistryDefinition } from '../types/skill-registry'
import { LocalSkillRegistryStore } from './local-skill-registry-store'
import {
  BlobSkillRegistryStore,
  IndeterminateRemoteMutationError,
  R2BlobBackend,
  sha256,
  type BlobBackend,
} from './skill-registry-store'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

const definition: SkillRegistryDefinition = {
  schema_version: '1', id: 'example', name: 'Example', enabled: true, priority: 10,
  adapter: 'skill_directory', source: { type: 'local', path: 'skills' }, refresh_interval_seconds: 43_200,
  retention: { catalog_revisions: 30 },
}

function catalog(revision: string): SkillRegistryCatalog {
  return {
    schema_version: '1', registry: definition, revision, content_revision: revision,
    source_revision: revision, synced_at: '2026-01-01T00:00:00.000Z', skills: [], diagnostics: [],
  }
}

async function exerciseStore(store: LocalSkillRegistryStore | BlobSkillRegistryStore) {
  await store.putDefinition(definition)
  expect((await store.getDefinition('example'))?.name).toBe('Example')
  const revision = 'a'.repeat(64)
  await store.publishCatalog(catalog(revision))
  await expect(store.publishCatalog({ ...catalog(revision), synced_at: '2026-01-02T00:00:00.000Z' })).resolves.toBeUndefined()
  expect((await store.getCatalog('example'))?.revision).toBe(revision)
  expect(await store.listRegistryIDs()).toEqual(['example'])

  const bytes = new TextEncoder().encode('artifact')
  const digest = await sha256(bytes)
  const descriptor: SkillArtifactDescriptor = {
    registry_id: 'example', package_id: 'package', skill_id: 'skill', source_revision: revision,
    format: 'memoh_skill_v1', digest, size: bytes.length, filename: 'skill.tar.gz',
    content_type: 'application/gzip', created_at: '2026-01-01T00:00:00.000Z',
  }
  await store.putArtifact(descriptor, bytes)
  const artifact = await store.getArtifact(digest)
  expect(artifact?.bytes).toEqual(bytes)
  expect(artifact?.descriptor).toEqual({
    format: 'memoh_skill_v1', digest, size: bytes.length, content_type: 'application/gzip',
  })
  await expect(store.putArtifact({ ...descriptor, source_revision: 'b'.repeat(64) }, bytes)).resolves.toEqual({ stored: false })
  await expect(store.putArtifact({ ...descriptor, size: bytes.length + 1 }, bytes)).rejects.toThrow('size')
  await expect(store.putArtifact({ ...descriptor, size: MAX_SKILL_ARTIFACT_COMPRESSED_BYTES + 1 }, bytes))
    .rejects.toThrow('compressed size limit')
  const imageBytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')
  const image: SkillImageAsset = {
    digest: await sha256(imageBytes), size: imageBytes.length, content_type: 'image/svg+xml',
  }
  await store.putImage(image, imageBytes)
  expect(await store.getImage(image.digest)).toEqual({ descriptor: image, bytes: imageBytes })
  return digest
}

function memoryBackend() {
  const objects = new Map<string, Uint8Array>()
  const gets = new Map<string, number>()
  const deletes: string[] = []
  const behavior = { failPuts: 0, landDespiteError: false, failDelete: '' }
  const backend: BlobBackend = {
    async get(key) {
      gets.set(key, (gets.get(key) ?? 0) + 1)
      return objects.get(key)?.slice() ?? null
    },
    async put(key, value) {
      if (behavior.failPuts > 0) {
        behavior.failPuts--
        if (behavior.landDespiteError) objects.set(key, value.slice())
        throw new IndeterminateRemoteMutationError(`S3 PUT outcome is unknown: ${key}`)
      }
      objects.set(key, value.slice())
    },
    async delete(key) {
      deletes.push(key)
      if (behavior.failDelete === key) throw new Error(`delete failed: ${key}`)
      objects.delete(key)
    },
    async list(prefix) {
      return [...objects.keys()].filter((key) => key.startsWith(prefix)).sort()
    },
  }
  return { backend, deletes, gets, behavior }
}

describe('Immutable digest-addressed uploads', () => {
  test('settles unknown outcomes, retries transient failures, and skips stored archives', async () => {
    const { backend, deletes, gets, behavior } = memoryBackend()
    const store = new BlobSkillRegistryStore(backend)
    const bytes = new TextEncoder().encode('artifact-retry')
    const digest = await sha256(bytes)
    const descriptor: SkillArtifactDescriptor = {
      registry_id: 'example', package_id: 'package', skill_id: 'skill', source_revision: 'a'.repeat(64),
      format: 'memoh_skill_v1', digest, size: bytes.length, filename: 'skill.tar.gz',
      content_type: 'application/gzip', created_at: '2026-01-01T00:00:00.000Z',
    }

    // The PUT reported an unknown outcome but actually landed: reading the key
    // back settles it without another write.
    behavior.failPuts = 1
    behavior.landDespiteError = true
    await expect(store.putArtifact(descriptor, bytes)).resolves.toEqual({ stored: true })
    expect((await store.getArtifact(digest))?.bytes).toEqual(bytes)

    // Steady state: matching metadata short-circuits the call and the archive
    // is never downloaded again.
    const archiveReads = gets.get(`skill-artifacts/${digest}.tar.gz`) ?? 0
    await expect(store.putArtifact(descriptor, bytes)).resolves.toEqual({ stored: false })
    expect(gets.get(`skill-artifacts/${digest}.tar.gz`) ?? 0).toBe(archiveReads)

    // GC removes the metadata commit marker before the archive. If deleting
    // the archive fails, the next refresh validates the orphaned bytes and
    // restores metadata instead of mistaking a missing archive for a hit.
    const metadataKey = `skill-artifacts/${digest}.json`
    const archiveKey = `skill-artifacts/${digest}.tar.gz`
    behavior.failDelete = archiveKey
    await expect(store.deleteArtifact(digest)).rejects.toThrow('delete failed')
    expect(deletes.slice(-2)).toEqual([metadataKey, archiveKey])
    behavior.failDelete = ''
    await expect(store.putArtifact(descriptor, bytes)).resolves.toEqual({ stored: false })
    expect((await store.getArtifact(digest))?.bytes).toEqual(bytes)

    // A transient failure that did not land is retried and succeeds.
    const secondBytes = new TextEncoder().encode('artifact-retry-second')
    const secondDescriptor: SkillArtifactDescriptor = {
      ...descriptor, digest: await sha256(secondBytes), size: secondBytes.length,
    }
    behavior.failPuts = 1
    behavior.landDespiteError = false
    await expect(store.putArtifact(secondDescriptor, secondBytes)).resolves.toEqual({ stored: true })

    // A failure that never lands surfaces a PLAIN error after retries: a late
    // duplicate PUT of identical bytes is harmless, so the writer lease must
    // not be poisoned by Artifact or image uploads.
    const imageBytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><title>retry</title></svg>')
    const image: SkillImageAsset = {
      digest: await sha256(imageBytes), size: imageBytes.length, content_type: 'image/svg+xml',
    }
    behavior.failPuts = Number.POSITIVE_INFINITY
    const failure = await store.putImage(image, imageBytes).catch((error) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(IndeterminateRemoteMutationError)
    expect(String(failure)).toContain('upload did not complete')

    // Once the network recovers, the same upload succeeds cleanly.
    behavior.failPuts = 0
    await expect(store.putImage(image, imageBytes)).resolves.toEqual({ stored: true })
    expect((await store.getImage(image.digest))?.bytes).toEqual(imageBytes)
  }, 15_000)
})

describe('SkillRegistryStore contract', () => {
  test('Local store publishes catalogs before pointers and stores content-addressed artifacts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skill-registry-store-'))
    roots.push(root)
    const store = new LocalSkillRegistryStore(root)
    const digest = await exerciseStore(store)
    const pointer = JSON.parse(await readFile(path.join(root, 'skill-registries/example/current.json'), 'utf8'))
    expect(pointer.revision).toBe('a'.repeat(64))
    await Bun.write(path.join(root, 'skill-registries/example/current.json'), JSON.stringify({ revision: '../invalid' }))
    await expect(store.getCatalog('example')).rejects.toThrow('digest')
    await Bun.write(path.join(root, 'skill-registries/example/current.json'), JSON.stringify(pointer))
    await Bun.write(path.join(root, `skill-artifacts/${digest}.tar.gz`), 'corrupt')
    await expect(store.getArtifact(digest)).rejects.toThrow('corrupt')
  })

  test('R2 backend handles paginated object listings', async () => {
    const objects = new Map<string, Uint8Array>()
    const versions = new Map<string, string>()
    let version = 0
    const bucket = {
      async get(key: string) {
        const value = objects.get(key)
        return value ? { arrayBuffer: async () => value.slice().buffer, etag: versions.get(key)! } : null
      },
      async put(key: string, value: Uint8Array, options?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }) {
        const current = versions.get(key)
        if (options?.onlyIf?.etagDoesNotMatch === '*' && current) return null
        if (options?.onlyIf?.etagMatches != null && options.onlyIf.etagMatches !== current) return null
        const etag = `version-${++version}`
        objects.set(key, value.slice())
        versions.set(key, etag)
        return { etag }
      },
      async delete(key: string) {
        objects.delete(key)
        versions.delete(key)
      },
      async list({ prefix = '', cursor, delimiter }: { prefix?: string; cursor?: string; delimiter?: string } = {}) {
        const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort()
        if (delimiter) {
          const delimitedPrefixes = [...new Set(keys.flatMap((key) => {
            const remainder = key.slice(prefix.length)
            const separator = remainder.indexOf(delimiter)
            return separator >= 0 ? [`${prefix}${remainder.slice(0, separator + 1)}`] : []
          }))]
          return { objects: [], delimitedPrefixes, truncated: false, cursor: undefined }
        }
        const offset = cursor ? Number(cursor) : 0
        const page = keys.slice(offset, offset + 1)
        return { objects: page.map((key) => ({ key })), truncated: offset + page.length < keys.length, cursor: String(offset + page.length) }
      },
    }
    const store = new BlobSkillRegistryStore(new R2BlobBackend(bucket))
    const digest = await exerciseStore(store)
    const streamed = await store.getArtifactStream(digest)
    expect(streamed?.body).toBeInstanceOf(ReadableStream)
    if (!(streamed?.body instanceof ReadableStream)) throw new Error('Expected an R2 Artifact stream')
    expect(new Uint8Array(await new Response(streamed.body).arrayBuffer()))
      .toEqual(new TextEncoder().encode('artifact'))
    objects.set(`skill-artifacts/${digest}.tar.gz`, new TextEncoder().encode('corrupt!'))
    const corrupt = await store.getArtifactStream(digest)
    if (!(corrupt?.body instanceof ReadableStream)) throw new Error('Expected a corrupt R2 Artifact stream')
    await expect(new Response(corrupt.body).arrayBuffer()).rejects.toThrow('corrupt')

  })
})
