import { parse as parseYaml } from 'yaml'
import type {
  BundledPluginSkill,
  PluginAuthRequirement,
  PluginAuthor,
  PluginIcon,
  PluginManifest,
  PluginMcpResource,
  PluginSkillResource,
  PluginVariable,
} from './types'

const pluginIDPattern = /^[a-z0-9][a-z0-9._-]*$/
const pluginFields = new Set([
  'schema_version', 'id', 'name', 'version', 'description', 'author', 'icon',
  'homepage', 'tags', 'capabilities', 'install', 'variables',
  'auth_requirements', 'mcps', 'skills',
])

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`)
  return value.trim()
}

function optionalString(value: unknown, label: string): string | undefined {
  return value == null ? undefined : string(value, label)
}

function strings(value: unknown, label: string): string[] | undefined {
  if (value == null) return undefined
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value.map((item, index) => string(item, `${label}[${index}]`))
}

function author(value: unknown, label: string): PluginAuthor {
  const data = object(value, label)
  return {
    name: string(data.name, `${label}.name`),
    email: optionalString(data.email, `${label}.email`) ?? '',
  }
}

function icon(value: unknown, label: string): PluginIcon | undefined {
  if (value == null) return undefined
  const data = object(value, label)
  if (data.kind === 'builtin') return { kind: 'builtin', name: string(data.name, `${label}.name`) }
  if (data.kind === 'external_url') {
    const url = string(data.url, `${label}.url`)
    if (!URL.canParse(url) || new URL(url).protocol !== 'https:') throw new Error(`${label}.url must use HTTPS`)
    return { kind: 'external_url', url }
  }
  throw new Error(`${label}.kind is unsupported`)
}

function variables(value: unknown, label: string): PluginVariable[] | undefined {
  if (value == null) return undefined
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value.map((item, index) => {
    const data = object(item, `${label}[${index}]`)
    return {
      key: string(data.key, `${label}[${index}].key`),
      description: string(data.description, `${label}[${index}].description`),
      defaultValue: optionalString(data.defaultValue, `${label}[${index}].defaultValue`),
    }
  })
}

function authRequirements(value: unknown, label: string): PluginAuthRequirement[] | undefined {
  if (value == null) return undefined
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  const seen = new Set<string>()
  return value.map((item, index) => {
    const itemLabel = `${label}[${index}]`
    const data = object(item, itemLabel)
    const key = string(data.key, `${itemLabel}.key`)
    if (seen.has(key)) throw new Error(`${label} contains duplicate key: ${key}`)
    seen.add(key)
    if (!['none', 'managed_oauth', 'user_secret'].includes(String(data.type))) {
      throw new Error(`${itemLabel}.type is unsupported`)
    }
    return {
      key,
      type: data.type as PluginAuthRequirement['type'],
      client_ref: optionalString(data.client_ref, `${itemLabel}.client_ref`),
      scopes: strings(data.scopes, `${itemLabel}.scopes`),
      variables: strings(data.variables, `${itemLabel}.variables`),
    }
  })
}

function mcps(value: unknown, label: string, authKeys: Set<string>): PluginMcpResource[] | undefined {
  if (value == null) return undefined
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  const seen = new Set<string>()
  return value.map((item, index) => {
    const itemLabel = `${label}[${index}]`
    const data = object(item, itemLabel)
    const key = string(data.key, `${itemLabel}.key`)
    if (seen.has(key)) throw new Error(`${label} contains duplicate key: ${key}`)
    seen.add(key)
    const transport = String(data.transport)
    if (!['http', 'sse', 'stdio'].includes(transport)) throw new Error(`${itemLabel}.transport is unsupported`)
    const authRef = optionalString(data.auth_ref, `${itemLabel}.auth_ref`)
    if (authRef && !authKeys.has(authRef)) throw new Error(`${itemLabel}.auth_ref references unknown auth requirement`)
    const resource: PluginMcpResource = {
      key,
      name: optionalString(data.name, `${itemLabel}.name`),
      display_name: optionalString(data.display_name, `${itemLabel}.display_name`),
      description: optionalString(data.description, `${itemLabel}.description`),
      transport: transport as PluginMcpResource['transport'],
      auth_ref: authRef,
      visibility: data.visibility == null ? undefined : String(data.visibility) as PluginMcpResource['visibility'],
      capabilities: strings(data.capabilities, `${itemLabel}.capabilities`),
    }
    if (resource.visibility && !['hidden', 'visible'].includes(resource.visibility)) {
      throw new Error(`${itemLabel}.visibility is unsupported`)
    }
    if (transport === 'stdio') {
      resource.command = string(data.command, `${itemLabel}.command`)
      resource.args = strings(data.args, `${itemLabel}.args`)
    } else {
      resource.url = string(data.url, `${itemLabel}.url`)
      if (!URL.canParse(resource.url) || new URL(resource.url).protocol !== 'https:') {
        throw new Error(`${itemLabel}.url must use HTTPS`)
      }
    }
    return resource
  })
}

function skills(value: unknown, label: string): PluginSkillResource[] | undefined {
  if (value == null) return undefined
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value.map((item, index) => {
    const data = object(item, `${label}[${index}]`)
    return {
      key: string(data.key, `${label}[${index}].key`),
      name: optionalString(data.name, `${label}[${index}].name`),
      path: string(data.path, `${label}[${index}].path`),
    }
  })
}

export function parsePluginManifest(raw: unknown, expectedID?: string): PluginManifest {
  const data = typeof raw === 'string' ? object(parseYaml(raw), 'Plugin manifest') : object(raw, 'Plugin manifest')
  const unsupported = Object.keys(data).find((field) => !pluginFields.has(field))
  if (unsupported) throw new Error(`Plugin manifest contains unsupported field: ${unsupported}`)
  if (String(data.schema_version) !== '1') throw new Error('Plugin manifest schema_version must be "1"')
  const id = string(data.id, 'Plugin manifest id')
  if (!pluginIDPattern.test(id)) throw new Error(`Invalid Plugin ID: ${id}`)
  if (expectedID && id !== expectedID) throw new Error(`Plugin ID ${id} does not match directory ${expectedID}`)
  const requirements = authRequirements(data.auth_requirements, `${id}.auth_requirements`)
  const install = data.install == null
    ? undefined
    : typeof data.install === 'string'
      ? string(data.install, `${id}.install`)
      : strings(data.install, `${id}.install`)
  return {
    schema_version: '1',
    id,
    name: string(data.name, `${id}.name`),
    version: string(data.version, `${id}.version`),
    description: string(data.description, `${id}.description`),
    author: author(data.author, `${id}.author`),
    icon: icon(data.icon, `${id}.icon`),
    homepage: optionalString(data.homepage, `${id}.homepage`),
    tags: strings(data.tags, `${id}.tags`),
    capabilities: strings(data.capabilities, `${id}.capabilities`),
    install,
    variables: variables(data.variables, `${id}.variables`),
    auth_requirements: requirements,
    mcps: mcps(data.mcps, `${id}.mcps`, new Set(requirements?.map((item) => item.key) ?? [])),
    skills: skills(data.skills, `${id}.skills`),
  }
}

export function parseBundledSkillDocument(id: string, text: string): BundledPluginSkill {
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (!frontmatter) throw new Error(`${id}/SKILL.md requires YAML frontmatter`)
  const data = object(parseYaml(frontmatter[1] ?? ''), `${id}/SKILL.md frontmatter`)
  const metadata = data.metadata == null ? {} : object(data.metadata, `${id}.metadata`)
  return {
    id,
    name: string(data.name, `${id}.name`),
    description: string(data.description, `${id}.description`),
    metadata: {
      author: metadata.author == null ? { name: '', email: '' } : author(metadata.author, `${id}.metadata.author`),
      tags: strings(metadata.tags, `${id}.metadata.tags`),
      homepage: optionalString(metadata.homepage, `${id}.metadata.homepage`),
    },
    content: (frontmatter[2] ?? '').trim(),
    files: [],
  }
}
