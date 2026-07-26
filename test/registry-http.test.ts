import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { H3 } from 'h3'
import { extractSkillArchive, gunzip, parseTarArchive } from '../client/archive'
import artifactDownload from '../server/api/artifacts/[digest]/download.get'
import skillImage from '../server/api/skill-images/[digest].get'
import catalogSearch from '../server/api/catalog/skills.get'
import registrySkill from '../server/api/registries/[id]/packages/[packageId]/skills/[skillId].get'
import registries from '../server/api/registries/index.get'
import type { CatalogSkill, SkillArtifactDescriptor, SkillRegistryCatalog, SkillRegistryDefinition } from '../server/types/skill-registry'
import { createTar, gzip } from '../server/utils/tar'
import { BlobSkillRegistryStore, R2BlobBackend, sha256 } from '../server/utils/skill-registry-store'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

function inMemoryBucket() {
  const objects = new Map<string, Uint8Array>()
  const versions = new Map<string, string>()
  let version = 0
  return {
    async get(key: string) {
      const value = objects.get(key)
      return value ? {
        size: value.length, body: new Blob([value.slice().buffer as ArrayBuffer]).stream(),
        arrayBuffer: async () => value.slice().buffer, etag: versions.get(key)!,
      } : null
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
      const page = keys.slice(offset, offset + 2)
      return {
        objects: page.map((key) => ({ key })), truncated: offset + page.length < keys.length,
        cursor: String(offset + page.length), delimitedPrefixes: [],
      }
    },
  }
}

describe('Skill Registry HTTP protocol', () => {
  test('discovers, searches, downloads and installs a namespaced Skill', async () => {
    const bucket = inMemoryBucket()
    const store = new BlobSkillRegistryStore(new R2BlobBackend(bucket))
    const definition: SkillRegistryDefinition = {
      schema_version: '1', id: 'example', name: 'Example', enabled: true, priority: 10,
      adapter: 'skill_directory', source: { type: 'local', path: 'skills' }, refresh_interval_seconds: 43_200,
      retention: { catalog_revisions: 30 },
    }
    const installID = 'example+tools+demo'
    const archive = await gzip(createTar({
      'SKILL.md': new TextEncoder().encode('---\nname: Demo\ndescription: Demo\n---\n'),
      'scripts/run.sh': { bytes: new TextEncoder().encode('#!/bin/sh\n'), mode: 0o755 },
    }, installID))
    const digest = await sha256(archive)
    const artifact: SkillArtifactDescriptor = {
      registry_id: 'example', package_id: 'tools', skill_id: 'demo', source_revision: 'source',
      format: 'memoh_skill_v1', digest, size: archive.length, filename: `${installID}.tar.gz`,
      content_type: 'application/gzip', created_at: '2026-01-01T00:00:00.000Z',
    }
    const imageBytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')
    const image = { digest: await sha256(imageBytes), size: imageBytes.length, content_type: 'image/svg+xml' as const }
    const skill: CatalogSkill = {
      schema_version: '1', registry_id: 'example', registry_priority: 10,
      package_id: 'tools', skill_id: 'demo', install_id: installID,
      name: 'Demo', description: 'Demo Skill', author: { name: 'Test', email: '' },
      tags: ['demo'], category: 'developer-tools', category_name: 'Developer Tools',
      runtime_requirements: { os: ['darwin', 'linux', 'win32'] },
      source: { type: 'local', revision: 'source', path: 'skills/demo' },
      files: ['SKILL.md', 'scripts/run.sh'], icon: { card: image, detail: image, brand_color: '#0B7285' }, artifact,
    }
    const revision = await sha256('catalog')
    const catalog: SkillRegistryCatalog = {
      schema_version: '1', registry: definition, revision, content_revision: revision,
      source_revision: 'source', synced_at: '2026-01-01T00:00:00.000Z', skills: [skill], diagnostics: [],
    }
    await store.putDefinition(definition)
    await store.putArtifact(artifact, archive)
    await store.putImage(image, imageBytes)
    await store.publishCatalog(catalog)
    await store.putStatus({ registry_id: definition.id, state: 'ready', current_revision: revision })

    const app = new H3()
    app.use((event) => { (event.req as any).runtime = { cloudflare: { env: { SKILL_REGISTRY_BUCKET: bucket } } } })
    app.get('/api/registries', registries)
    app.get('/api/catalog/skills', catalogSearch)
    app.get('/api/registries/:id/packages/:packageId/skills/:skillId', registrySkill)
    app.get('/api/artifacts/:digest/download', artifactDownload)
    app.get('/api/skill-images/:digest', skillImage)

    const registryResponse = await app.fetch(new Request('http://local/api/registries'))
    expect(registryResponse.status).toBe(200)
    expect((await registryResponse.json() as any).data[0]).toMatchObject({ id: 'example', skill_count: 1 })

    const searchResponse = await app.fetch(new Request('http://local/api/catalog/skills?q=demo&os=linux'))
    expect(searchResponse.status).toBe(200)
    expect((await searchResponse.json() as any).data[0]).toMatchObject({
      registry_id: 'example', package_id: 'tools', skill_id: 'demo',
    })
    expect((await app.fetch(new Request('http://local/api/catalog/skills?registry=BAD'))).status).toBe(400)

    const detailResponse = await app.fetch(new Request('http://local/api/registries/example/packages/tools/skills/demo'))
    const detail = await detailResponse.json() as any
    expect(detail.artifact.download_url).toBe(`/api/artifacts/${digest}/download`)
    expect(detail.icon.card.download_url).toBe(`/api/skill-images/${image.digest}`)
    const imageResponse = await app.fetch(new Request(`http://local${detail.icon.card.download_url}`))
    expect(imageResponse.headers.get('content-type')).toBe('image/svg+xml')
    expect(imageResponse.headers.get('cache-control')).toContain('immutable')
    expect(new Uint8Array(await imageResponse.arrayBuffer())).toEqual(imageBytes)

    const downloadURL = `http://local${detail.artifact.download_url}`
    const downloadResponse = await app.fetch(new Request(downloadURL))
    expect(downloadResponse.headers.get('etag')).toBe(`"${digest}"`)
    expect(downloadResponse.headers.get('x-content-sha256')).toBe(digest)
    const downloaded = new Uint8Array(await downloadResponse.arrayBuffer())
    expect(await sha256(downloaded)).toBe(digest)
    const notModified = await app.fetch(new Request(downloadURL, { headers: { 'if-none-match': `"${digest}"` } }))
    expect(notModified.status).toBe(304)

    const destination = await mkdtemp(path.join(os.tmpdir(), 'registry-http-install-'))
    roots.push(destination)
    const installed = await extractSkillArchive(parseTarArchive(await gunzip(downloaded)), destination, installID)
    expect(await readFile(path.join(installed, 'SKILL.md'), 'utf8')).toContain('name: Demo')
    expect((await stat(path.join(installed, 'scripts/run.sh'))).mode & 0o777).toBe(0o755)
  })
})
