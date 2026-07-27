import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { SkillRegistryDefinition, SkillRegistryStatus } from '../server/types/skill-registry'
import { IndeterminateRemoteMutationError } from '../server/utils/skill-registry-store'
import { loadSkillRegistryDefinitionResults, type SkillRegistryRefreshProgress } from './skill-registry/refresher'
import { createSkillRegistryProgressRenderer, runSkillRegistryRefreshes } from './skill-registry-refresh'

function definition(id: string, enabled = true): SkillRegistryDefinition {
  return {
    schema_version: '1', id, name: id, enabled, priority: 10,
    adapter: 'skill_directory', source: { type: 'local', path: 'skills' }, refresh_interval_seconds: 43_200,
    retention: { catalog_revisions: 30 },
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

  test('stops immediately when a remote mutation outcome is unknown', async () => {
    const calls: string[] = []
    await expect(runSkillRegistryRefreshes({
      definitions: [definition('first'), definition('second')],
      store: {
        getDefinition: async (id) => definition(id),
        getStatus: async () => null,
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

  test('renders progress lines for phases, uploads, and milestones', () => {
    const events: SkillRegistryRefreshProgress[] = [
      { type: 'source', registry: 'openai' },
      { type: 'source_unchanged', registry: 'memoh', revision: 'e'.repeat(40) },
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
    expect(output).toContain(`memoh: source unchanged at ${'e'.repeat(12)}, skipping`)
    expect(output).toContain(`openai: source revision ${'f'.repeat(12)}`)
    expect(output).toContain('openai: packaging 60 Skills (2 diagnostics)')
    expect(output).toContain('[1/60] pkg/uploaded-one (uploaded)')
    expect(output).not.toContain('cached-two')
    expect(output).toContain('[25/60] pkg/milestone')
    expect(output).toContain('[60/60] pkg/last')
    expect(output).toContain(`openai: publishing revision ${'f'.repeat(12)}`)

    const interactive: string[] = []
    const renderInteractive = createSkillRegistryProgressRenderer((text) => { interactive.push(text) }, true)
    for (const event of events) renderInteractive(event)
    expect(interactive.join('')).toContain('\r\u001B[2K' + 'openai: [2/60] pkg/cached-two')
    expect(interactive.join('')).toContain('openai: publishing revision')
  })

  test('loads valid Registry definitions alongside a malformed file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'registry-definition-results-'))
    try {
      await mkdir(path.join(root, 'registries/valid'), { recursive: true })
      await mkdir(path.join(root, 'registries/broken'), { recursive: true })
      await writeFile(path.join(root, 'registries/valid/registry.yaml'), `schema_version: "1"\nid: valid\nname: Valid\nadapter: skill_directory\nsource:\n  type: local\n  path: skills\nrefresh_interval: 12h\nretention:\n  catalog_revisions: 30\n`)
      await writeFile(path.join(root, 'registries/broken/registry.yaml'), 'schema_version: [')
      const result = await loadSkillRegistryDefinitionResults(root)
      expect(result.definitions.map((item) => item.id)).toEqual(['valid'])
      expect(result.failures).toHaveLength(1)
      expect(result.failures[0]?.registry).toBe('broken')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
