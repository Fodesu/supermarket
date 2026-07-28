import type {
  RegistryDiagnostic,
  SkillAuthor,
  SkillIcon,
  SkillImageAsset,
  SkillRegistryDefinition,
  SkillRuntimeRequirements,
} from '../types'
import type { SkillSourceFile } from '../artifacts/build'

export interface SkillCandidate {
  package_id: string
  skill_id: string
  install_id: string
  name: string
  description: string
  author: SkillAuthor
  homepage?: string
  tags: string[]
  category: string
  category_name: string
  source_category?: string
  runtime_requirements: SkillRuntimeRequirements
  source_path: string
  files: Record<string, SkillSourceFile>
  icon?: SkillIcon
  icon_assets?: Array<{ descriptor: SkillImageAsset; bytes: Uint8Array }>
}

export interface SkillAdapterResult {
  skills: SkillCandidate[]
  diagnostics: RegistryDiagnostic[]
}

export interface SkillAdapterInput {
  definition: SkillRegistryDefinition
  sourceRoot: string
  ensurePaths: (paths: string[]) => Promise<void>
  packageFilter?: string
  skillFilter?: string
  allowMissingScope: boolean
}
