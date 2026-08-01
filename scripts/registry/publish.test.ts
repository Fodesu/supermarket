import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { LocalSkillRegistryStore } from '#registry/storage/local'
import type { SkillRegistryDefinition } from '#registry/types'
import { assertPartialRegistryDependencies } from './publish'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

const definition = (id: string): SkillRegistryDefinition => ({
  schema_version: '1',
  id,
  name: id,
  enabled: true,
  priority: 10,
  adapter: { type: 'skill_directory' },
  source: { type: 'local', path: `registries/${id}/skills` },
})

describe('partial Registry publication', () => {
  test('fails before publication when another approved Registry is absent from the Store', async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'partial-registry-project-'))
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'partial-registry-data-'))
    roots.push(projectRoot, dataRoot)
    const other = definition('other')
    const candidate = { definition: other, revision: 'a'.repeat(64) }

    await expect(assertPartialRegistryDependencies({
      selectedRegistry: 'selected',
      candidates: [candidate],
      store: new LocalSkillRegistryStore(dataRoot),
    })).rejects.toThrow('run a full Registry publication first')
  })
})
