import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import type {
  BundledPluginSkill,
  PluginManifest,
} from './types'

const pluginIDPattern = /^[a-z0-9][a-z0-9._-]*$/

const trimmed = z.string().transform((value) => value.trim())
const nonEmpty = trimmed.refine((value) => value.length > 0, 'is required')
const optionalNonEmpty = nonEmpty.optional()
const stringList = z.array(nonEmpty).optional()

function httpsURL(message: string) {
  return nonEmpty.refine(
    (value) => URL.canParse(value) && new URL(value).protocol === 'https:',
    message,
  )
}

const authorSchema = z.object({
  name: nonEmpty,
  email: optionalNonEmpty,
}).transform((value) => ({ name: value.name, email: value.email ?? '' }))

const iconSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('builtin'), name: nonEmpty }),
  z.object({ kind: z.literal('external_url'), url: httpsURL('icon.url must use HTTPS') }),
])

const variableSchema = z.object({
  key: nonEmpty,
  description: nonEmpty,
  defaultValue: optionalNonEmpty,
})

const authRequirementSchema = z.object({
  key: nonEmpty,
  type: z.enum(['none', 'managed_oauth', 'user_secret']),
  client_ref: optionalNonEmpty,
  scopes: stringList,
  variables: stringList,
})

const mcpBaseShape = {
  key: nonEmpty,
  name: optionalNonEmpty,
  display_name: optionalNonEmpty,
  description: optionalNonEmpty,
  auth_ref: optionalNonEmpty,
  visibility: z.enum(['hidden', 'visible']).optional(),
  capabilities: stringList,
}

const mcpSchema = z.discriminatedUnion('transport', [
  z.object({ ...mcpBaseShape, transport: z.literal('stdio'), command: nonEmpty, args: stringList }),
  z.object({ ...mcpBaseShape, transport: z.literal('http'), url: httpsURL('mcp.url must use HTTPS') }),
  z.object({ ...mcpBaseShape, transport: z.literal('sse'), url: httpsURL('mcp.url must use HTTPS') }),
])

const skillSchema = z.object({
  key: nonEmpty,
  name: optionalNonEmpty,
  path: nonEmpty,
})

const bundledSkillFrontmatterSchema = z.object({
  name: nonEmpty,
  description: nonEmpty,
  metadata: z.object({
    author: authorSchema.optional(),
    tags: stringList,
    homepage: optionalNonEmpty,
  }).optional(),
})

function uniqueKeys(label: string) {
  return (items: Array<{ key: string }>, ctx: z.RefinementCtx) => {
    const seen = new Set<string>()
    for (const item of items) {
      if (seen.has(item.key)) ctx.addIssue({ code: 'custom', message: `${label} contains duplicate key: ${item.key}` })
      seen.add(item.key)
    }
  }
}

const pluginManifestSchema = z.object({
  schema_version: z.literal('1'),
  id: nonEmpty.refine((value) => pluginIDPattern.test(value), 'Invalid Plugin ID'),
  name: nonEmpty,
  version: nonEmpty,
  description: nonEmpty,
  author: authorSchema,
  icon: iconSchema.optional(),
  homepage: optionalNonEmpty,
  tags: stringList,
  capabilities: stringList,
  install: z.union([nonEmpty, z.array(nonEmpty)]).optional(),
  variables: z.array(variableSchema).optional(),
  auth_requirements: z.array(authRequirementSchema).superRefine(uniqueKeys('auth_requirements')).optional(),
  mcps: z.array(mcpSchema).superRefine(uniqueKeys('mcps')).optional(),
  skills: z.array(skillSchema).optional(),
}).superRefine((manifest, ctx) => {
  const authKeys = new Set((manifest.auth_requirements ?? []).map((item) => item.key))
  manifest.mcps?.forEach((mcp, index) => {
    if (mcp.auth_ref && !authKeys.has(mcp.auth_ref)) {
      ctx.addIssue({ code: 'custom', path: ['mcps', index, 'auth_ref'], message: 'references unknown auth requirement' })
    }
  })
})

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function decode<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (result.success) return result.data
  const issue = result.error.issues[0]!
  throw new Error(issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message)
}

const pluginFields = new Set([
  'schema_version', 'id', 'name', 'version', 'description', 'author', 'icon',
  'homepage', 'tags', 'capabilities', 'install', 'variables',
  'auth_requirements', 'mcps', 'skills',
])

export function parsePluginManifest(raw: unknown, expectedID?: string): PluginManifest {
  const data = object(typeof raw === 'string' ? parseYaml(raw) : raw, 'Plugin manifest')
  const unsupported = Object.keys(data).find((field) => !pluginFields.has(field))
  if (unsupported) throw new Error(`Plugin manifest contains unsupported field: ${unsupported}`)
  if (String(data.schema_version) !== '1') throw new Error('Plugin manifest schema_version must be "1"')
  const manifest = decode(pluginManifestSchema, data)
  if (expectedID && manifest.id !== expectedID) {
    throw new Error(`Plugin ID ${manifest.id} does not match directory ${expectedID}`)
  }
  return manifest
}

export function parseBundledSkillDocument(id: string, text: string): BundledPluginSkill {
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (!frontmatter) throw new Error(`${id}/SKILL.md requires YAML frontmatter`)
  const parsed = decode(bundledSkillFrontmatterSchema, object(parseYaml(frontmatter[1] ?? ''), `${id}/SKILL.md frontmatter`))
  return {
    id,
    name: parsed.name,
    description: parsed.description,
    metadata: {
      author: parsed.metadata?.author ?? { name: '', email: '' },
      tags: parsed.metadata?.tags,
      homepage: parsed.metadata?.homepage,
    },
    content: (frontmatter[2] ?? '').trim(),
    files: [],
  }
}

