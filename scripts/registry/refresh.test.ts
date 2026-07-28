import { describe, expect, test } from 'bun:test'
import type { SkillRegistryDefinition, SkillRegistryStatus } from '#registry/types'
import { IndeterminateRemoteMutationError } from '#registry/storage/contracts'
import type { SkillRegistryRefreshProgress } from '#registry/refresh/refresher'
import { createSkillRegistryProgressRenderer, runSkillRegistryRefreshes } from './refresh'

function definition(id: string, enabled = true): SkillRegistryDefinition {
  return {
    schema_version: '1', id, name: id, enabled, priority: 10,
    adapter: { type: 'skill_directory' }, source: { type: 'local', path: 'skills' }, refresh_interval_seconds: 43_200,
    retention: { snapshots: 30 },
  }
}

describe('Skill Registry refresh runner', () => {
  test('applies definition changes immediately and isolates Registry failures', async () => {
    const definitions = [definition('first', false), definition('second')]
    const statuses = new Map<string, SkillRegistryStatus>([
      ['first', { state: 'ready', last_success_at: new Date().toISOString() }],
      ['second', { state: 'ready', last_success_at: '2020-01-01T00:00:00.000Z' }],
    ])
    const calls: string[] = []
    const outcome = await runSkillRegistryRefreshes({
      definitions, due: true,
      store: {
        listRegistryIDs: async () => [],
        getState: async (id) => ({
          schema_version: '2' as const,
          definition: id === 'first' ? definition('first', true) : definition(id),
          status: statuses.get(id) ?? { state: 'empty' as const },
        }),
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
        listRegistryIDs: async () => [],
        getState: async () => ({
          schema_version: '2' as const, definition: item,
          status: { state: 'disabled' as const },
        }),
      },
      refresher: { refresh: async () => { throw new Error('must not refresh') } },
    })
    expect(outcome).toEqual({ results: [{ registry: item.id, skipped: 'disabled' }], failures: [] })
  })

  test('stops immediately when a remote mutation outcome is unknown', async () => {
    const calls: string[] = []
    await expect(runSkillRegistryRefreshes({
      definitions: [definition('first'), definition('second')],
      store: {
        listRegistryIDs: async () => [],
        getState: async (id) => ({
          schema_version: '2' as const, definition: definition(id),
          status: { state: 'empty' as const },
        }),
      },
      refresher: {
        refresh: async (item) => {
          calls.push(item.id)
          throw new IndeterminateRemoteMutationError('unknown remote write')
        },
      },
    })).rejects.toThrow('unknown remote write')
    expect(calls).toEqual(['first'])
  })

  test('disables published Registries removed from the committed definitions', async () => {
    const refreshed: SkillRegistryDefinition[] = []
    const outcome = await runSkillRegistryRefreshes({
      definitions: [definition('current')],
      reconcileRemoved: true,
      knownRegistryIDs: ['current', 'invalid-definition'],
      store: {
        listRegistryIDs: async () => ['current', 'removed', 'invalid-definition'],
        getState: async (id) => ({
          schema_version: '2' as const,
          definition: definition(id),
          status: { state: 'ready' as const, last_success_at: '2026-01-01T00:00:00.000Z' },
        }),
      },
      refresher: {
        refresh: async (item) => {
          refreshed.push(item)
          return { registry: item.id, skipped: item.enabled ? 'unchanged' : 'disabled' }
        },
      },
    })

    expect(refreshed.map((item) => [item.id, item.enabled])).toEqual([
      ['current', true],
      ['removed', false],
    ])
    expect(outcome.failures).toEqual([])
  })

  test('renders progress lines for phases, uploads, and milestones', () => {
    const events: SkillRegistryRefreshProgress[] = [
      { type: 'source', registry: 'openai' },
      { type: 'source_ready', registry: 'openai', revision: 'f'.repeat(64) },
      { type: 'scanned', registry: 'openai', skills: 60, diagnostics: 2 },
      { type: 'skill', registry: 'openai', index: 1, total: 60, package_id: 'pkg', skill_id: 'uploaded-one', uploaded: true },
      { type: 'skill', registry: 'openai', index: 2, total: 60, package_id: 'pkg', skill_id: 'cached-two', uploaded: false },
      { type: 'skill', registry: 'openai', index: 25, total: 60, package_id: 'pkg', skill_id: 'milestone', uploaded: false },
      { type: 'skill', registry: 'openai', index: 60, total: 60, package_id: 'pkg', skill_id: 'last', uploaded: false },
      { type: 'publishing', registry: 'openai', revision: 'f'.repeat(64) },
    ]

    const plain: string[] = []
    const renderPlain = createSkillRegistryProgressRenderer((text) => { plain.push(text) }, false)
    for (const event of events) renderPlain(event)
    const output = plain.join('')
    expect(output).toContain('openai: fetching source')
    expect(output).toContain(`openai: source revision ${'f'.repeat(12)}`)
    expect(output).toContain('openai: packaging 60 Skills (2 diagnostics)')
    expect(output).toContain('[1/60] pkg/uploaded-one (uploaded)')
    expect(output).not.toContain('cached-two')
    expect(output).toContain('[25/60] pkg/milestone')
    expect(output).toContain('[60/60] pkg/last')
    expect(output).toContain(`openai: publishing revision ${'f'.repeat(12)}`)
  })
})
