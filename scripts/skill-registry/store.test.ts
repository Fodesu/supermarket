import { describe, expect, test } from 'bun:test'
import { S3BlobBackend } from './store'

describe('S3 Registry blob backend', () => {
  test('uses the same keys, pagination and delimiter semantics as the R2 reader', async () => {
    const objects = new Map<string, Uint8Array>()
    const client = {
      file(key: string) {
        return {
          exists: async () => objects.has(key),
          arrayBuffer: async () => objects.get(key)!.slice().buffer,
        }
      },
      async write(key: string, value: Uint8Array) { objects.set(key, value.slice()) },
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
    const backend = new S3BlobBackend(client)
    await backend.put('skill-registries/memoh/definition.json', new TextEncoder().encode('definition'))
    await backend.put('skill-registries/openai/current.json', new TextEncoder().encode('current'))
    expect(new TextDecoder().decode((await backend.get('skill-registries/memoh/definition.json'))!)).toBe('definition')
    expect(await backend.list('skill-registries/')).toEqual([
      'skill-registries/memoh/definition.json', 'skill-registries/openai/current.json',
    ])
    expect(await backend.listPrefixes('skill-registries/')).toEqual([
      'skill-registries/memoh/', 'skill-registries/openai/',
    ])
  })
})
