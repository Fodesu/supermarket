import type { SkillAuthor } from './skill'

export const MAX_SKILL_ARTIFACT_COMPRESSED_BYTES = 25 * 1024 * 1024
export const MAX_SKILL_ARTIFACT_UNCOMPRESSED_BYTES = 100 * 1024 * 1024
export const MAX_SKILL_ARTIFACT_FILES = 10_000

export type SkillRegistryAdapter = 'skill_directory' | 'codex_marketplace_skills'
export type SkillRuntimeOS = 'darwin' | 'linux' | 'win32'

export interface SkillRuntimeRequirements {
  os: SkillRuntimeOS[]
}

export type SkillRegistrySource =
  | { type: 'local'; path: string }
  | { type: 'git'; url: string; ref?: string; path?: string }

export interface SkillRegistryDefinition {
  schema_version: '1'
  id: string
  name: string
  enabled: boolean
  priority: number
  adapter: SkillRegistryAdapter
  source: SkillRegistrySource
  catalog_path?: string
  refresh_interval_seconds: number
  taxonomy?: { mappings?: Record<string, string> }
  defaults?: { runtime_requirements?: SkillRuntimeRequirements }
  package_overrides?: Record<string, { runtime_requirements?: SkillRuntimeRequirements }>
  skill_overrides?: Record<string, { runtime_requirements?: SkillRuntimeRequirements }>
}

export interface SkillArtifactDescriptor {
  registry_id: string
  package_id: string
  skill_id: string
  source_revision: string
  format: 'memoh_skill_v1'
  digest: string
  size: number
  filename: string
  content_type: 'application/gzip'
  created_at: string
}

export interface SkillArtifactBlob {
  format: 'memoh_skill_v1'
  digest: string
  size: number
  content_type: 'application/gzip'
}

export interface CatalogSkill {
  schema_version: '1'
  registry_id: string
  registry_priority: number
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
  source: {
    type: SkillRegistrySource['type']
    revision: string
    path: string
    repository?: string
  }
  files: string[]
  artifact: SkillArtifactDescriptor
}

export interface RegistryDiagnostic {
  package_id?: string
  skill_id?: string
  code: 'source_requires_runtime_components' | 'no_skills'
  message: string
}

export interface SkillRegistryCatalog {
  schema_version: '1'
  registry: SkillRegistryDefinition
  revision: string
  content_revision: string
  source_revision: string
  synced_at: string
  skills: CatalogSkill[]
  diagnostics: RegistryDiagnostic[]
}

export interface SkillRegistryStatus {
  registry_id: string
  state: 'ready' | 'refreshing' | 'stale' | 'empty' | 'disabled'
  current_revision?: string
  last_attempt_at?: string
  last_success_at?: string
  last_error?: string
}

export interface SkillRegistrySummary {
  id: string
  name: string
  enabled: boolean
  priority: number
  adapter: SkillRegistryAdapter
  revision?: string
  synced_at?: string
  skill_count: number
  package_count: number
  category_count: number
  skipped_package_count: number
  refresh_interval_seconds: number
  next_refresh_at?: string
  status: SkillRegistryStatus['state']
  last_error?: string
}

export interface SkillCategorySummary {
  id: string
  name: string
  count: number
  registries: Array<{ id: string; count: number }>
}
