import type { SkillRegistryDefinition } from '../types'
import { readCodexMarketplace } from './codex-marketplace'
import { readSkillDirectory } from './skill-directory'
import { readSkillPackageDirectory } from './skill-package-directory'

export function skillAdapterBootstrapPaths(definition: SkillRegistryDefinition): string[] {
  if (definition.adapter.type === 'codex_marketplace_skills') return [definition.adapter.catalog_path]
  return []
}

export function buildSkillCandidates(input: {
  definition: SkillRegistryDefinition
  sourceRoot: string
  ensurePaths?: (paths: string[]) => Promise<void>
}) {
  const { definition, sourceRoot, ensurePaths = async () => {} } = input
  const adapterInput = { definition, sourceRoot, ensurePaths }
  if (definition.adapter.type === 'skill_directory') return readSkillDirectory(adapterInput)
  if (definition.adapter.type === 'skill_package_directory') return readSkillPackageDirectory(adapterInput)
  if (definition.adapter.type === 'codex_marketplace_skills') return readCodexMarketplace(adapterInput)
  throw new Error(`${definition.id}: unsupported adapter`)
}
