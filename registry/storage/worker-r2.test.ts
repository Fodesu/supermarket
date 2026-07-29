import { afterEach, describe, expect, test } from 'bun:test'
import { WorkerR2BlobBackend } from './worker-r2'

const names = ['REGISTRY_STATE_URL', 'REGISTRY_WRITER_TOKEN'] as const
const original = Object.fromEntries(names.map((name) => [name, process.env[name]]))

afterEach(() => {
  for (const name of names) {
    if (original[name] == null) delete process.env[name]
    else process.env[name] = original[name]
  }
})

describe('Worker Registry blob backend', () => {
  test('routes mutable writes through the token-protected Writer host', async () => {
    const requests: Request[] = []
    const backend = new WorkerR2BlobBackend('http://registry-blobs', async (input, init) => {
      requests.push(new Request(input, init))
      return new Response(null, { status: 201 })
    })
    process.env.REGISTRY_STATE_URL = 'http://registry-state'
    process.env.REGISTRY_WRITER_TOKEN = 'fencing-token'

    await backend.put('skill-registries/memoh/state.json', new TextEncoder().encode('{}'))
    await backend.put('skill-artifacts/a'.padEnd(80, 'a'), new Uint8Array())

    expect(requests[0]?.url).toStartWith('http://registry-state/')
    expect(requests[0]?.headers.get('x-registry-writer-token')).toBe('fencing-token')
    expect(requests[1]?.url).toStartWith('http://registry-blobs/')
    expect(requests[1]?.headers.has('x-registry-writer-token')).toBeFalse()
  })

  test('uses create-only writes for immutable objects', async () => {
    const requests: Request[] = []
    const backend = new WorkerR2BlobBackend('http://registry-blobs', async (input, init) => {
      requests.push(new Request(input, init))
      return new Response(null, { status: 201, headers: { etag: 'created' } })
    })
    const key = `skill-artifacts/${'a'.repeat(64)}.tar.gz`

    await expect(backend.putConditional(key, new Uint8Array(), null)).resolves.toBe('created')
    expect(requests[0]?.headers.get('if-none-match')).toBe('*')
  })

  test('requests delimiter-based Registry prefix discovery', async () => {
    const requests: Request[] = []
    const backend = new WorkerR2BlobBackend('http://registry-blobs', async (input, init) => {
      requests.push(new Request(input, init))
      return Response.json({ keys: ['skill-registries/memoh/'] })
    })

    await expect(backend.listPrefixes('skill-registries/'))
      .resolves.toEqual(['skill-registries/memoh/'])
    expect(new URL(requests[0]!.url).searchParams.get('delimiter')).toBe('/')
  })
})
