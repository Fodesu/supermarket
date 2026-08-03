export const MAX_PLUGIN_RELEASE_PACKAGES = 128
export const MAX_PLUGIN_SKILL_ARTIFACTS_COMPRESSED_BYTES = 128 * 1024 * 1024
export const MAX_PLUGIN_SKILL_ARTIFACTS_UNCOMPRESSED_BYTES = 128 * 1024 * 1024
export const MAX_PLUGIN_SKILL_ARTIFACTS_ARCHIVE_BYTES = 128 * 1024 * 1024
export const MAX_PLUGIN_SKILL_ARTIFACTS_FILES = 10_000

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

export interface PluginPackageReference {
  registry_id: string
  package_id: string
}

export interface PluginResolvedPackage extends PluginPackageReference {
  revision: string
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
  packages?: PluginPackageReference[]
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
  packages: PluginResolvedPackage[]
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

export interface PublicPluginRelease {
  revision: string
  published_at: string
  artifact: PublicPluginArtifactDescriptor
  packages: PluginResolvedPackage[]
}

export type PublishedPluginEntry = PluginManifest & { release: PublicPluginRelease }
