import { describe, expect, test } from 'bun:test'
import { packagePlugin } from './artifact'
import type { CommittedPlugin } from './repository'

function incompressibleBytes(size: number, seed: number) {
  const bytes = new Uint8Array(size)
  let value = seed || 1
  for (let index = 0; index < bytes.length; index++) {
    value ^= value << 13
    value ^= value >>> 17
    value ^= value << 5
    bytes[index] = value & 0xff
  }
  return bytes
}

describe('Plugin Artifact packaging', () => {
  test('rejects a compressed Plugin Artifact above its download limit', async () => {
    const plugin: CommittedPlugin = {
      id: 'example',
      manifest: {
        schema_version: '1', id: 'example', name: 'Example', version: '1.0.0',
        description: 'Example', author: { name: 'Memoh', email: '' },
      },
      files: Object.fromEntries(Array.from({ length: 4 }, (_, index) => [
        `scripts/noise-${index}.bin`,
        { bytes: incompressibleBytes(1_600_000, index + 1), mode: 0o644 as const },
      ])),
    }

    await expect(packagePlugin(plugin)).rejects.toThrow('Compressed Plugin Artifact exceeds')
  })
})
