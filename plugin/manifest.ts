import { parse as parseYaml } from 'yaml'
import * as z from 'zod/mini'
import {
  MAX_PLUGIN_RELEASE_PACKAGES,
  type PluginManifest,
  type PluginPackageReference,
} from './types'
import { isIdentifier, isRegistryComponentID } from '#registry/definition'

const isRegistryID = (value: string) => value !== 'user' && isRegistryComponentID(value)

const trimmed = z.pipe(z.string(), z.transform((value) => value.trim()))
const nonEmpty = trimmed.check(z.minLength(1, 'is required'))
const optionalNonEmpty = z.optional(nonEmpty)
const stringList = z.optional(z.array(nonEmpty))

function httpsURL(message: string) {
  return nonEmpty.check(z.refine(
    (value) => URL.canParse(value) && new URL(value).protocol === 'https:',
    message,
  ))
}

const authorSchema = z.pipe(
  z.object({
    name: nonEmpty,
    email: optionalNonEmpty,
  }),
  z.transform((value) => ({ name: value.name, email: value.email ?? '' })),
)

const iconSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('builtin'), name: nonEmpty }),
  z.object({ kind: z.literal('external_url'), url: httpsURL('icon.url must use HTTPS') }),
])

const packageSchema = z.object({
  registry_id: nonEmpty.check(z.refine(isRegistryID, 'Invalid Registry ID')),
  package_id: nonEmpty.check(z.refine(isRegistryComponentID, 'Invalid package ID')),
})

function uniquePackageReferences(items: PluginPackageReference[], ctx: z.core.$RefinementCtx<PluginPackageReference[]>) {
  if (items.length > MAX_PLUGIN_RELEASE_PACKAGES) {
    ctx.addIssue({ code: 'custom', message: `packages exceeds the ${MAX_PLUGIN_RELEASE_PACKAGES} Package limit` })
  }
  const seen = new Set<string>()
  for (const item of items) {
    const identity = pluginPackageReferenceIdentity(item)
    if (seen.has(identity)) ctx.addIssue({ code: 'custom', message: `packages contains duplicate reference: ${identity}` })
    seen.add(identity)
  }
}

const pluginManifestSchema = z.object({
  schema_version: z.literal('1'),
  id: nonEmpty.check(z.refine(isIdentifier, 'Invalid Plugin ID')),
  name: nonEmpty,
  version: nonEmpty,
  description: nonEmpty,
  author: authorSchema,
  icon: z.optional(iconSchema),
  homepage: optionalNonEmpty,
  tags: stringList,
  capabilities: stringList,
  install: z.optional(z.union([nonEmpty, z.array(nonEmpty)])),
  packages: z.optional(z.array(packageSchema).check(z.superRefine(uniquePackageReferences))),
})

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function decode<T>(schema: z.ZodMiniType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (result.success) return result.data
  const issue = result.error.issues[0]!
  throw new Error(issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message)
}

const pluginFields = new Set([
  'schema_version', 'id', 'name', 'version', 'description', 'author', 'icon',
  'homepage', 'tags', 'capabilities', 'install', 'packages',
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

export function pluginPackageReferenceIdentity(reference: PluginPackageReference): string {
  return `${reference.registry_id}/${reference.package_id}`
}
