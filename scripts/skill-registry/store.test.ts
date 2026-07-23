import { describe, expect, test } from 'bun:test'
import { IndeterminateRemoteMutationError } from '../../server/utils/skill-registry-store'
import { S3BlobBackend } from './store'

describe('S3 Registry blob backend', () => {
  test('uses the same keys, pagination and delimiter semantics as the R2 reader', async () => {
    const objects = new Map<string, Uint8Array>()
    const versions = new Map<string, string>()
    let version = 0
    const client = {
      file(key: string) {
        return {
          exists: async () => objects.has(key),
          arrayBuffer: async () => objects.get(key)!.slice().buffer,
          stat: async () => ({ etag: versions.get(key) }),
        }
      },
      async write(key: string, value: Uint8Array) {
        objects.set(key, value.slice())
        versions.set(key, `version-${++version}`)
      },
      async delete(key: string) {
        objects.delete(key)
        versions.delete(key)
      },
      presign(key: string) { return `https://s3.test/${encodeURIComponent(key)}` },
      async list({ prefix = '', delimiter, continuationToken }: any) {
        const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort()
        if (delimiter) {
          const commonPrefixes = [...new Set(keys.flatMap((key) => {
            const remainder = key.slice(prefix.length)
            const separator = remainder.indexOf(delimiter)
            return separator >= 0 ? [`${prefix}${remainder.slice(0, separator + 1)}`] : []
          }))].map((item) => ({ prefix: item }))
          return { commonPrefixes, contents: [], isTruncated: false }
        }
        const offset = continuationToken ? Number(continuationToken) : 0
        const page = keys.slice(offset, offset + 1)
        return {
          contents: page.map((key) => ({ key })), isTruncated: offset + page.length < keys.length,
          nextContinuationToken: String(offset + page.length),
        }
      },
    }
    const conditionalFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const key = decodeURIComponent(new URL(String(input)).pathname.slice(1))
      const method = init?.method ?? 'GET'
      if (method === 'GET') {
        const value = objects.get(key)
        return value
          ? new Response(value.slice().buffer as ArrayBuffer, { status: 200, headers: { etag: `"${versions.get(key)}"` } })
          : new Response(null, { status: 404 })
      }
      if (method === 'DELETE') {
        objects.delete(key)
        versions.delete(key)
        return new Response(null, { status: 204 })
      }
      const headers = new Headers(init?.headers)
      const current = versions.get(key)
      const ifNoneMatch = headers.get('if-none-match')
      const ifMatch = headers.get('if-match')?.replace(/^"|"$/g, '')
      if ((ifNoneMatch === '*' && current) || (ifMatch != null && ifMatch !== current)) {
        return new Response(null, { status: 412 })
      }
      const etag = `version-${++version}`
      objects.set(key, new Uint8Array(init?.body as ArrayBuffer))
      versions.set(key, etag)
      return new Response(null, { status: 200, headers: { etag: `"${etag}"` } })
    }
    const backend = new S3BlobBackend(client, conditionalFetch as typeof fetch)
    await backend.put('skill-registries/memoh/definition.json', new TextEncoder().encode('definition'))
    await backend.put('skill-registries/openai/current.json', new TextEncoder().encode('current'))
    expect(new TextDecoder().decode((await backend.get('skill-registries/memoh/definition.json'))!)).toBe('definition')
    expect(await backend.list('skill-registries/')).toEqual([
      'skill-registries/memoh/definition.json', 'skill-registries/openai/current.json',
    ])
    expect(await backend.listPrefixes('skill-registries/')).toEqual([
      'skill-registries/memoh/', 'skill-registries/openai/',
    ])
    const versioned = await backend.getVersioned('skill-registries/memoh/definition.json')
    expect(versioned?.version).toBe('version-1')
    expect(await backend.putConditional(
      'skill-registry-maintenance/writer-lease.json', new TextEncoder().encode('first'), null,
    )).toBe('version-3')
    expect(await backend.putConditional(
      'skill-registry-maintenance/writer-lease.json', new TextEncoder().encode('conflict'), null,
    )).toBeNull()
    expect(await backend.putConditional(
      'skill-registry-maintenance/writer-lease.json', new TextEncoder().encode('second'), 'version-3',
    )).toBe('version-4')
    await backend.delete('skill-registry-maintenance/writer-lease.json')
    expect(await backend.get('skill-registry-maintenance/writer-lease.json')).toBeNull()

    const failedFetch = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch
    const indeterminate = new S3BlobBackend(client, failedFetch)
    await expect(indeterminate.put('skill-registries/memoh/status.json', new Uint8Array()))
      .rejects.toBeInstanceOf(IndeterminateRemoteMutationError)
  })
})
