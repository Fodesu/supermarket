import { describe, expect, test } from 'bun:test'
import type { SkillRegistryDefinition, SkillRegistryStatus } from '../server/types/skill-registry'
import { runSkillRegistryRefreshes } from './skill-registry-refresh'

function definition(id: string, enabled = true): SkillRegistryDefinition {
  return {
    schema_version: '1', id, name: id, enabled, priority: 10,
    adapter: 'skill_directory', source: { type: 'local', path: 'skills' }, refresh_interval_seconds: 43_200,
  }
}

describe('Skill Registry refresh runner', () => {
  test('applies definition changes immediately and isolates Registry failures', async () => {
    const definitions = [definition('first', false), definition('second')]
    const statuses = new Map<string, SkillRegistryStatus>([
      ['first', { registry_id: 'first', state: 'ready', last_success_at: new Date().toISOString() }],
      ['second', { registry_id: 'second', state: 'ready', last_success_at: '2020-01-01T00:00:00.000Z' }],
    ])
    const calls: string[] = []
    const outcome = await runSkillRegistryRefreshes({
      definitions, due: true,
      store: {
        getDefinition: async (id) => id === 'first' ? definition('first', true) : definition(id),
        getStatus: async (id) => statuses.get(id) ?? null,
      },
      refresher: {
        refresh: async (item) => {
          calls.push(item.id)
          if (item.id === 'first') throw new Error('first failed')
          return { registry: item.id, refreshed: true }
        },
      },
    })
    expect(calls).toEqual(['first', 'second'])
    expect(outcome.results).toEqual([{ registry: 'second', refreshed: true }])
    expect(outcome.failures).toHaveLength(1)
  })

  test('does not repeatedly process an unchanged disabled Registry', async () => {
    const item = definition('disabled', false)
    const outcome = await runSkillRegistryRefreshes({
      definitions: [item], due: true,
      store: {
        getDefinition: async () => item,
        getStatus: async () => ({ registry_id: item.id, state: 'disabled' }),
      },
      refresher: { refresh: async () => { throw new Error('must not refresh') } },
    })
    expect(outcome).toEqual({ results: [{ registry: item.id, skipped: 'disabled' }], failures: [] })
  })
})
