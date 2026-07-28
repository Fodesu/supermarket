import { MAX_TAR_UNCOMPRESSED_BYTES } from '#archive/tar'

export interface SkillAuthor {
  name: string
  email: string
}

export const MAX_SKILL_ARTIFACT_COMPRESSED_BYTES = 25 * 1024 * 1024
export const MAX_SKILL_ARTIFACT_UNCOMPRESSED_BYTES = MAX_TAR_UNCOMPRESSED_BYTES
export const MAX_SKILL_ARTIFACT_FILES = 10_000
export const MAX_SKILL_IMAGE_BYTES = 512 * 1024

export type SkillRegistryAdapter =
  | { type: 'skill_directory' }
  | { type: 'codex_marketplace_skills'; catalog_path: string }
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
  refresh_interval_seconds: number
  retention: { snapshots: number }
}

export interface SkillArtifactDescriptor {
  format: 'memoh_skill_v1'
  digest: string
  size: number
  content_type: 'application/gzip'
}

export type SkillArtifactBlob = SkillArtifactDescriptor

export type SkillImageContentType = 'image/svg+xml' | 'image/png' | 'image/jpeg' | 'image/webp'

export interface SkillImageAsset {
  digest: string
  size: number
  content_type: SkillImageContentType
}

export interface SkillIcon {
  card?: SkillImageAsset
  detail?: SkillImageAsset
  dark?: SkillImageAsset
  brand_color?: string
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
  runtime_requirements?: SkillRuntimeRequirements
  source: {
    type: SkillRegistrySource['type']
    revision: string
    path: string
    repository?: string
  }
  files: string[]
  icon?: SkillIcon
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
  source_revision: string
  synced_at: string
  skills: CatalogSkill[]
  diagnostics: RegistryDiagnostic[]
}

export interface SkillRegistryStatus {
  state: 'ready' | 'refreshing' | 'stale' | 'empty' | 'disabled'
  last_attempt_at?: string
  last_success_at?: string
  last_error?: string
}

/**
 * The only mutable object for one Registry. A state update switches the
 * complete reader-visible view together: its definition, active snapshot,
 * and refresh status.
 */
export interface SkillRegistryState {
  schema_version: '2'
  definition: SkillRegistryDefinition
  current_snapshot?: string
  current_summary?: SkillRegistryCurrentSummary
  status: SkillRegistryStatus
}

/**
 * The compact, reader-facing projection of the active Snapshot. It lives in
 * state.json so Registry listings do not have to download every Snapshot.
 */
export interface SkillRegistryCurrentSummary {
  revision: string
  source_revision: string
  synced_at: string
  skill_count: number
  package_count: number
  category_count: number
  skipped_package_count: number
}

export interface SkillRegistrySummary {
  id: string
  name: string
  enabled: boolean
  priority: number
  adapter: SkillRegistryAdapter['type']
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
