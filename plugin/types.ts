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

export interface PluginSkillResource {
  key: string
  name?: string
  path: string
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
  skills?: PluginSkillResource[]
}

export interface BundledPluginSkill {
  id: string
  name: string
  description: string
  metadata: {
    author: PluginAuthor
    tags?: string[]
    homepage?: string
  }
  content: string
  files: string[]
}

export interface PluginEntry extends PluginManifest {
  bundled_skills?: BundledPluginSkill[]
}
