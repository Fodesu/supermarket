import type { SkillRegistryDefinition } from '../types'
import { readCodexMarketplace } from './codex-marketplace'
import { readSkillDirectory } from './skill-directory'

export function buildSkillCandidates(input: {
  definition: SkillRegistryDefinition
  sourceRoot: string
  ensurePaths?: (paths: string[]) => Promise<void>
  packageFilter?: string
  skillFilter?: string
  allowMissingScope?: boolean
}) {
  const {
    definition,
    sourceRoot,
    packageFilter,
    skillFilter,
    allowMissingScope = false,
    ensurePaths = async () => {},
  } = input
  if (skillFilter && !packageFilter) throw new Error('--skill requires --package')
  const adapterInput = {
    definition, sourceRoot, ensurePaths, packageFilter, skillFilter, allowMissingScope,
  }
  if (definition.adapter === 'skill_directory') return readSkillDirectory(adapterInput)
  if (definition.adapter === 'codex_marketplace_skills') return readCodexMarketplace(adapterInput)
  throw new Error(`${definition.id}: unsupported adapter ${definition.adapter}`)
}
