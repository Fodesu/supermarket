import type { SkillArtifactDescriptor, SkillRuntimeRequirements } from '#registry/types'

export const MAX_PLUGIN_RELEASE_SKILLS = 128
export const MAX_PLUGIN_SKILL_ARTIFACTS_COMPRESSED_BYTES = 128 * 1024 * 1024

export interface PluginAuthor {
  name: string
  email: string
}

export interface PluginVariable {
  key: string
  description: string
  defaultValue?: string
}

export type PluginIcon =
  | { kind: 'builtin'; name: string }
  | { kind: 'external_url'; url: string }

export interface PluginAuthRequirement {
  key: string
  type: 'none' | 'managed_oauth' | 'user_secret'
  client_ref?: string
  scopes?: string[]
  variables?: string[]
}

export interface PluginMcpResource {
  key: string
  name?: string
  display_name?: string
  description?: string
  transport: 'sse' | 'http' | 'stdio'
  url?: string
  command?: string
  args?: string[]
  auth_ref?: string
  visibility?: 'hidden' | 'visible'
  capabilities?: string[]
}

export interface PluginSkillReference {
  registry_id: string
  package_id: string
  skill_id: string
}

export interface PluginResolvedSkill extends PluginSkillReference {
  registry_revision: string
  source_revision: string
  install_id: string
  runtime_requirements?: SkillRuntimeRequirements
  artifact: SkillArtifactDescriptor
}

export interface PluginManifest {
  schema_version: '1'
  id: string
  name: string
  version: string
  description: string
  author: PluginAuthor
  icon?: PluginIcon
  homepage?: string
  tags?: string[]
  capabilities?: string[]
  install?: string | string[]
  variables?: PluginVariable[]
  auth_requirements?: PluginAuthRequirement[]
  mcps?: PluginMcpResource[]
  skills?: PluginSkillReference[]
}

export interface PluginArtifactDescriptor {
  format: 'memoh_plugin_v1'
  digest: string
  size: number
  content_type: 'application/gzip'
}

/** Immutable release payload. Its canonical JSON digest is the release revision. */
export interface PluginRelease {
  schema_version: '1'
  plugin: PluginManifest
  artifact: PluginArtifactDescriptor
  skills: PluginResolvedSkill[]
}

export interface PluginReleaseCurrentSummary {
  revision: string
  published_at: string
  name: string
  version: string
}

/** The only mutable object for one Plugin. */
export interface PluginReleaseState {
  schema_version: '1'
  plugin_id: string
  enabled: boolean
  current_release?: string
  current_summary?: PluginReleaseCurrentSummary
}

export type PublicPluginArtifactDescriptor = PluginArtifactDescriptor & { download_url: string }

export type PublicPluginResolvedSkill = Omit<PluginResolvedSkill, 'artifact'> & {
  artifact: SkillArtifactDescriptor & { download_url: string }
}

export interface PublicPluginRelease {
  revision: string
  published_at: string
  artifact: PublicPluginArtifactDescriptor
  skills: PublicPluginResolvedSkill[]
}

export type PublishedPluginEntry = PluginManifest & { release: PublicPluginRelease }
