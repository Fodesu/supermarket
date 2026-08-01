import { describe, expect, test } from 'bun:test'
import {
  assertPluginReleaseCandidate,
  parsePluginReleaseLock,
  serializePluginReleaseLock,
} from './release-lock'

describe('Plugin release locks', () => {
  test('round-trips canonical locks and rejects mismatched candidates', () => {
    const revision = 'a'.repeat(64)
    const lock = parsePluginReleaseLock(
      serializePluginReleaseLock({ release_revision: revision }),
      'example',
    )
    expect(lock).toEqual({ release_revision: revision })
    expect(() => assertPluginReleaseCandidate('example', lock, 'b'.repeat(64)))
      .toThrow('but the rebuilt release is')
  })

  test('rejects non-canonical or malformed locks', () => {
    expect(() => parsePluginReleaseLock(
      new TextEncoder().encode(`{"release_revision":"${'a'.repeat(64)}"}`),
      'example',
    )).toThrow('canonical JSON')
    expect(() => parsePluginReleaseLock(
      new TextEncoder().encode('{"release_revision":"latest"}\n'),
      'example',
    )).toThrow('valid release_revision')
  })
})
