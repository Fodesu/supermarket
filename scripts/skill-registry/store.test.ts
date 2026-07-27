import { afterEach, describe, expect, test } from 'bun:test'
import { WorkerR2BlobBackend, createSkillRegistryStore } from './store'

const names = ['REGISTRY_R2_INTERNAL_URL', 'REGISTRY_R2_MUTABLE_URL', 'REGISTRY_WRITER_TOKEN', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'] as const
const original = Object.fromEntries(names.map((name) => [name, process.env[name]]))

afterEach(() => {
  for (const name of names) {
    if (original[name] == null) delete process.env[name]
    else process.env[name] = original[name]
  }
})

describe('Worker Registry blob backend', () => {
  test('routes mutable writes through the token-protected coordinator host', async () => {
    const requests: Request[] = []
    const backend = new WorkerR2BlobBackend('http://registry-r2', async (input, init) => {
      requests.push(new Request(input, init))
      return new Response(null, { status: 201 })
    })
    process.env.REGISTRY_R2_MUTABLE_URL = 'http://registry-mutable'
    process.env.REGISTRY_WRITER_TOKEN = 'fencing-token'

    await backend.put('skill-registries/memoh/current.json', new TextEncoder().encode('{}'))
    await backend.put('skill-artifacts/a'.padEnd(80, 'a'), new Uint8Array())

    expect(requests[0]?.url).toStartWith('http://registry-mutable/')
    expect(requests[0]?.headers.get('x-registry-writer-token')).toBe('fencing-token')
    expect(requests[1]?.url).toStartWith('http://registry-r2/')
    expect(requests[1]?.headers.has('x-registry-writer-token')).toBeFalse()
  })

  test('rejects legacy direct S3 writer configuration', () => {
    process.env.R2_ACCOUNT_ID = 'account'
    expect(() => createSkillRegistryStore()).toThrow('Direct R2 S3 registry writers are not supported')
  })
})
