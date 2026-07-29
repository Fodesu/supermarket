import { describe, expect, test } from 'bun:test'
import {
  decideRegistryRefresh,
  nextRegistryRefreshAt,
  nextRegistryRefreshFromBucket,
} from './refresh-schedule'

function state(input: { enabled?: boolean; interval?: number; lastSuccess?: string } = {}) {
  return {
    schema_version: '1',
    definition: {
      enabled: input.enabled ?? true,
      refresh_interval_seconds: input.interval ?? 43_200,
    },
    status: {
      state: input.enabled === false ? 'disabled' : 'ready',
      last_success_at: input.lastSuccess,
    },
  }
}

describe('Registry refresh scheduling', () => {
  test('chooses whether to run, inspect state, or keep the existing schedule', () => {
    const cases = [
      ['manual refresh', true, 'current', 'current', undefined, 'run'],
      ['new Worker version', false, 'new', 'old', Date.parse('2026-01-02T00:00:00.000Z'), 'run'],
      ['future schedule', false, 'current', 'current', Date.parse('2026-01-02T00:00:00.000Z'), 'skip'],
      ['due schedule', false, 'current', 'current', Date.parse('2026-01-01T00:00:00.000Z'), 'run'],
      ['missing schedule', false, 'current', 'current', undefined, 'inspect_state'],
    ] as const
    for (const [_name, force, workerVersion, handledWorkerVersion, scheduledRefreshAt, expected] of cases) {
      expect(decideRegistryRefresh({
        force,
        workerVersion,
        handledWorkerVersion,
        scheduledRefreshAt,
        now: Date.parse('2026-01-01T00:00:00.000Z'),
      }).action).toBe(expected)
    }
  })

  test('computes the next deadline from enabled Registry state', () => {
    const now = Date.parse('2026-01-01T00:00:00.000Z')
    expect(nextRegistryRefreshAt([
      state({ lastSuccess: '2026-01-01T00:00:00.000Z' }),
      state({ interval: 3_600, lastSuccess: '2026-01-01T00:30:00.000Z' }),
      state({ enabled: false }),
    ], now)).toBe(Date.parse('2026-01-01T01:30:00.000Z'))
    expect(nextRegistryRefreshAt([state()], now)).toBe(now)
    expect(nextRegistryRefreshAt([state({ enabled: false })])).toBeNull()
  })

  test('rejects malformed scheduling state', () => {
    expect(() => nextRegistryRefreshAt([{
      schema_version: '1',
      definition: { enabled: true, refresh_interval_seconds: 0 },
      status: {},
    }])).toThrow()
    expect(() => nextRegistryRefreshAt([state({
      interval: Number.MAX_SAFE_INTEGER,
      lastSuccess: '2026-01-01T00:00:00.000Z',
    })])).toThrow('outside the supported time range')
  })

  test('discovers Registry states without listing Snapshot history', async () => {
    const values = new Map([
      ['skill-registries/memoh/state.json', state({
        interval: 3_600,
        lastSuccess: '2026-01-01T00:00:00.000Z',
      })],
    ])
    const bucket = {
      async list(options: R2ListOptions) {
        expect(options).toMatchObject({ prefix: 'skill-registries/', delimiter: '/' })
        return {
          objects: [],
          delimitedPrefixes: ['skill-registries/memoh/'],
          truncated: false,
        }
      },
      async get(key: string) {
        const value = values.get(key)
        if (!value) return null
        const text = JSON.stringify(value)
        return {
          size: text.length,
          json: async () => value,
        }
      },
    } as unknown as R2Bucket

    await expect(nextRegistryRefreshFromBucket(
      bucket,
      Date.parse('2026-01-01T00:30:00.000Z'),
    )).resolves.toBe(Date.parse('2026-01-01T01:00:00.000Z'))
  })
})
