import { describe, expect, test } from 'bun:test'
import { isRegistryGcDue, registryGcIntervalMs } from './maintenance'

describe('Registry Writer maintenance schedule', () => {
  test('runs initially and then no more than once per day', () => {
    const now = Date.parse('2026-07-27T00:00:00.000Z')
    expect(isRegistryGcDue(undefined, now)).toBeTrue()
    expect(isRegistryGcDue('2026-07-26T00:00:01.000Z', now)).toBeFalse()
    expect(isRegistryGcDue('2026-07-26T00:00:00.000Z', now)).toBeTrue()
    expect(isRegistryGcDue('invalid', now)).toBeTrue()
    expect(registryGcIntervalMs).toBe(86_400_000)
  })
})
