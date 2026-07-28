import { describe, expect, test } from 'bun:test'
import { access, readdir } from 'node:fs/promises'
import path from 'node:path'
import { buildSkillCandidates } from '../adapters/index'
import { loadSkillRegistryDefinitions } from './refresher'
import { materializeSkillRegistrySource } from '../sources/index'

describe('Committed Skill Registries', () => {
  test('publishes every committed Memoh Skill with its complete file set', async () => {
    const projectRoot = path.resolve(import.meta.dirname, '../..')
    const definition = (await loadSkillRegistryDefinitions(projectRoot)).find((item) => item.id === 'memoh')!
    const entries = (await readdir(path.join(projectRoot, 'skills'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
    const expected = (await Promise.all(entries.map(async (entry) => {
      try {
        await access(path.join(projectRoot, 'skills', entry.name, 'SKILL.md'))
        return entry.name
      } catch {
        return undefined
      }
    }))).filter((id): id is string => Boolean(id)).sort()
    const source = await materializeSkillRegistrySource(definition, projectRoot)
    const result = await buildSkillCandidates({ definition, sourceRoot: source.root })
    expect(result.skills.map((skill) => skill.skill_id).sort()).toEqual(expected)
    expect(result.skills.every((skill) => Boolean(skill.files['SKILL.md']))).toBe(true)
    expect(result.skills.find((skill) => skill.skill_id === 'docx')?.files['scripts/accept_changes.py']?.mode).toBe(0o755)
  })
})
