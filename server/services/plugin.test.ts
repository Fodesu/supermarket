import { describe, expect, test } from 'bun:test'
import type { PluginReleaseStore } from '#plugin/storage/contracts'
import type { PluginRelease } from '#plugin/types'
import { cachedRelease } from './plugin'

function release(): PluginRelease {
  return {
    schema_version: '1',
    plugin: {
      schema_version: '1', id: 'example', name: 'Example', version: '1.0.0',
      description: 'Example', author: { name: 'Memoh', email: '' },
    },
    artifact: {
      format: 'memoh_plugin_v1', digest: 'a'.repeat(64), size: 1,
      content_type: 'application/gzip',
    },
    skills: [],
  }
}

describe('Plugin release service cache', () => {
  test('does not retain a missing immutable release after it is published', async () => {
    let current: PluginRelease | null = null
    let reads = 0
    const store = {
      async getRelease() {
        reads++
        return current
      },
    } as unknown as PluginReleaseStore

    expect(await cachedRelease(store, 'example', 'b'.repeat(64))).toBeNull()
    current = release()
    expect(await cachedRelease(store, 'example', 'b'.repeat(64))).toEqual(current)
    expect(await cachedRelease(store, 'example', 'b'.repeat(64))).toEqual(current)
    expect(reads).toBe(2)
  })

  test('does not share in-flight Store I/O between requests', async () => {
    const resolvers: Array<(value: PluginRelease) => void> = []
    let reads = 0
    const store = {
      async getRelease() {
        reads++
        return new Promise<PluginRelease>((resolve) => resolvers.push(resolve))
      },
    } as unknown as PluginReleaseStore
    const revision = 'c'.repeat(64)

    const first = cachedRelease(store, 'example', revision)
    const second = cachedRelease(store, 'example', revision)
    expect(reads).toBe(2)
    for (const resolve of resolvers) resolve(release())
    await expect(first).resolves.toEqual(release())
    await expect(second).resolves.toEqual(release())
  })
})
