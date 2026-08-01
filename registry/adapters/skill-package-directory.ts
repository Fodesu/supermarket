import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { assertRegistryComponentID } from '../definition'
import { resolveRealInside } from '../filesystem'
import { buildSkillCandidate } from './common'
import { compareCanonicalText } from '#lib/order'
import type { SkillAdapterInput, SkillAdapterResult, SkillCandidate } from './types'

export async function readSkillPackageDirectory(input: SkillAdapterInput): Promise<SkillAdapterResult> {
  const { definition, sourceRoot } = input
  const skills: SkillCandidate[] = []
  const packages = (await readdir(sourceRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => compareCanonicalText(a.name, b.name))

  for (const packageEntry of packages) {
    const packageID = assertRegistryComponentID(packageEntry.name, 'package ID')
    const packageRoot = await resolveRealInside(sourceRoot, packageID)
    const skillsRoot = await resolveRealInside(packageRoot, 'skills')
    const entries = (await readdir(skillsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => compareCanonicalText(a.name, b.name))
    if (!entries.length) throw new Error(`${definition.id}/${packageID}: package contains no skills`)

    for (const entry of entries) {
      const skillID = assertRegistryComponentID(entry.name, 'skill ID')
      const skillRoot = await resolveRealInside(skillsRoot, skillID)
      try {
        await readFile(path.join(skillRoot, 'SKILL.md'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(`${definition.id}/${packageID}/${skillID}: missing SKILL.md`)
        }
        throw error
      }
      skills.push(await buildSkillCandidate({
        definition,
        packageID,
        skillID,
        sourcePath: `${packageID}/skills/${skillID}`,
        root: skillRoot,
        allowedRoot: packageRoot,
      }))
    }
  }
  return { skills, diagnostics: [] }
}
