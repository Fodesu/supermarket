import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { assertRegistryID } from '../definition'
import { resolveRealInside } from '../filesystem'
import { buildSkillCandidate } from './common'
import type { SkillAdapterInput, SkillAdapterResult, SkillCandidate } from './types'

export async function readSkillDirectory(input: SkillAdapterInput): Promise<SkillAdapterResult> {
  const { definition, sourceRoot, packageFilter, skillFilter, allowMissingScope } = input
  const skills: SkillCandidate[] = []
  const entries = await readdir(sourceRoot, { withFileTypes: true })
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      await readFile(path.join(sourceRoot, entry.name, 'SKILL.md'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    const id = assertRegistryID(entry.name, 'skill ID')
    if (packageFilter && id !== packageFilter) continue
    if (skillFilter && id !== skillFilter) continue
    skills.push(await buildSkillCandidate({
      definition, packageID: id, skillID: id, sourcePath: id,
      root: await resolveRealInside(sourceRoot, id), allowedRoot: sourceRoot,
    }))
  }
  if ((packageFilter || skillFilter) && skills.length === 0 && !allowMissingScope) {
    throw new Error(`${definition.id}: skill "${skillFilter ?? packageFilter}" not found`)
  }
  return { skills, diagnostics: [] }
}
