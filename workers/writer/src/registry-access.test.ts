import { describe, expect, test } from 'bun:test'
import {
  activeRegistryRun,
  isAllowedRegistryListPrefix,
  isImmutableRegistryKey,
  isRegistryStateKey,
  objectKey,
} from './registry-access'

describe('Writer Registry access policy', () => {
  test('separates mutable state from immutable publication objects', () => {
    expect(isRegistryStateKey('skill-registries/openai/state.json')).toBe(true)
    expect(isRegistryStateKey('skill-registries/openai/snapshots/a.json')).toBe(false)
    expect(isImmutableRegistryKey(`skill-registries/openai/snapshots/${'a'.repeat(64)}.json`)).toBe(true)
    expect(isImmutableRegistryKey(`skill-artifacts/${'b'.repeat(64)}.tar.gz`)).toBe(true)
    expect(isImmutableRegistryKey(`skill-artifacts/${'b'.repeat(64)}.json`)).toBe(false)
    expect(isImmutableRegistryKey('unknown/state.json')).toBe(false)
  })

  test('rejects malformed object paths and broad list prefixes', () => {
    expect(objectKey('/objects/skill-artifacts%2Fabc.tar.gz')).toBe('skill-artifacts/abc.tar.gz')
    expect(objectKey('/objects/skill-artifacts%2F..%2Fstate.json')).toBeUndefined()
    expect(isAllowedRegistryListPrefix('skill-artifacts/')).toBe(true)
    expect(isAllowedRegistryListPrefix('skill-registries/openai/snapshots/')).toBe(false)
    expect(isAllowedRegistryListPrefix('')).toBe(false)
  })

  test('only accepts unexpired persisted runs', () => {
    const now = Date.parse('2026-07-28T00:00:00.000Z')
    expect(activeRegistryRun({
      token: 'run-token',
      started_at: '2026-07-27T23:00:00.000Z',
      expires_at: '2026-07-28T01:00:00.000Z',
    }, now)?.token).toBe('run-token')
    expect(activeRegistryRun({
      token: 'expired',
      started_at: '2026-07-27T22:00:00.000Z',
      expires_at: '2026-07-28T00:00:00.000Z',
    }, now)).toBeNull()
    expect(activeRegistryRun({ token: 'invalid' }, now)).toBeNull()
  })
})
