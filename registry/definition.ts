import path from 'node:path'
import * as z from 'zod/mini'
import type {
  SkillRegistryDefinition,
  SkillRuntimeOS,
  SkillRuntimeRequirements,
} from './types'

export const supportedSkillRuntimeOS: SkillRuntimeOS[] = ['darwin', 'linux', 'win32']
const runtimeOS = new Set<string>(supportedSkillRuntimeOS)
const safeIDPattern = /^[a-z0-9][a-z0-9_-]*$/
const gitRevisionPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/

function unsupportedFieldError(label: string) {
  return { error: (issue: z.core.$ZodRawIssue) => issue.code === 'unrecognized_keys'
    ? `${label} contains unsupported field ${(issue as { keys: string[] }).keys.join(', ')}`
    : undefined }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

export function assertIdentifier(value: string, label = 'ID'): string {
  if (!safeIDPattern.test(value)) throw new Error(`Invalid ${label}: ${value}`)
  return value
}

export function assertRegistryID(value: string, label = 'registry ID'): string {
  const id = assertIdentifier(value, label)
  if (id === 'user') throw new Error(`Reserved ${label}: ${value}`)
  return id
}

export function isIdentifier(value: string): boolean {
  return safeIDPattern.test(value)
}

export function skillInstallID(registryID: string, packageID: string, skillID: string): string {
  return [
    assertRegistryID(registryID, 'registry ID'),
    assertIdentifier(packageID, 'package ID'),
    assertIdentifier(skillID, 'skill ID'),
  ].join('+')
}

export function isSkillRuntimeOS(value: string): value is SkillRuntimeOS {
  return runtimeOS.has(value)
}

export function safeRelativePath(value: string, label = 'path'): string {
  const normalized = path.posix.normalize(value.replaceAll('\\', '/')).replace(/^\.\//, '').replace(/\/$/, '')
  if (!normalized || normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    throw new Error(`${label} escapes its source: ${value}`)
  }
  return normalized === '.' ? '' : normalized
}

function parseRuntimeRequirements(raw: unknown, label: string): SkillRuntimeRequirements | undefined {
  if (raw == null) return undefined
  const schema = z.strictObject({
    os: z.array(z.unknown()).check(z.minLength(1)),
  }, unsupportedFieldError(label))
  const result = schema.safeParse(raw)
  if (!result.success) {
    const issue = result.error.issues[0]!
    if (issue.code === 'unrecognized_keys') throw new Error(issue.message)
    if (issue.code === 'invalid_type' && issue.path.length === 0) throw new Error(`${label} must be an object`)
    throw new Error(`${label}.os must be a non-empty array`)
  }
  const values = result.data.os.map((item) => String(item).toLowerCase().trim())
  const invalid = values.find((item) => !runtimeOS.has(item))
  if (invalid) throw new Error(`${label}.os contains unsupported value: ${invalid}`)
  const selected = new Set(values)
  return { os: supportedSkillRuntimeOS.filter((item) => selected.has(item)) }
}

export function resolveSkillRuntimeRequirements(
  definition: SkillRegistryDefinition,
  packageID: string,
  skillID: string,
  declared?: unknown,
): SkillRuntimeRequirements | undefined {
  return parseRuntimeRequirements(declared, `${definition.id}/${packageID}/${skillID}.runtime_requirements`)
}

function parseAdapter(raw: unknown, id: string): SkillRegistryDefinition['adapter'] {
  const data = object(raw, `${id}: adapter`)
  const type = String(data.type ?? '')
  if (type === 'skill_directory') {
    const parsed = z.strictObject({ type: z.literal('skill_directory') }, {
      error: (issue) => issue.code === 'unrecognized_keys' ? `${id}: skill_directory adapter contains unsupported fields` : undefined,
    }).safeParse(data)
    if (!parsed.success) throw new Error(parsed.error.issues[0]!.message)
    return { type: 'skill_directory' }
  }
  if (type === 'skill_package_directory') {
    const parsed = z.strictObject({ type: z.literal('skill_package_directory') }, {
      error: (issue) => issue.code === 'unrecognized_keys' ? `${id}: skill_package_directory adapter contains unsupported fields` : undefined,
    }).safeParse(data)
    if (!parsed.success) throw new Error(parsed.error.issues[0]!.message)
    return { type: 'skill_package_directory' }
  }
  if (type === 'codex_marketplace_skills') {
    const parsed = z.strictObject({
      type: z.literal('codex_marketplace_skills'),
      catalog_path: z.pipe(z.string(), z.transform((value) => value.trim())).check(z.minLength(1)),
    }, {
      error: (issue) => issue.code === 'unrecognized_keys' ? `${id}: codex_marketplace_skills adapter contains unsupported fields` : undefined,
    }).safeParse(data)
    if (!parsed.success) throw new Error(`${id}: adapter.catalog_path is required for ${type}`)
    return { type: 'codex_marketplace_skills', catalog_path: safeRelativePath(parsed.data.catalog_path, 'catalog path') }
  }
  throw new Error(`${id}: unsupported adapter ${type}`)
}

function parseSource(raw: unknown, id: string): SkillRegistryDefinition['source'] {
  const data = object(raw, `${id}: source`)
  if (data.type === 'local') {
    const parsed = z.strictObject({
      type: z.literal('local'),
      path: z.pipe(z.string(), z.transform((value) => value.trim())).check(z.minLength(1)),
    }, unsupportedFieldError(`${id}: local source`)).safeParse(data)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!
      if (issue.code === 'unrecognized_keys') throw new Error(issue.message)
      throw new Error(`${id}: local source.path is required`)
    }
    return { type: 'local', path: parsed.data.path === '.' ? '' : safeRelativePath(parsed.data.path, 'local source path') }
  }
  if (data.type === 'git') {
    const parsed = z.strictObject({
      type: z.literal('git'),
      url: z.pipe(z.string(), z.transform((value) => value.trim()))
        .check(z.refine((value) => /^https:\/\//.test(value), `${id}: git source URL must use HTTPS`)),
      revision: z.pipe(z.string(), z.transform((value) => value.trim().toLowerCase()))
        .check(z.regex(gitRevisionPattern)),
      tracking_ref: z.optional(z.pipe(z.string(), z.transform((value) => value.trim())).check(z.minLength(1))),
      path: z.optional(z.string()),
    }, unsupportedFieldError(`${id}: git source`)).safeParse(data)
    if (!parsed.success) {
      if (parsed.error.issues.some((issue) => issue.path[0] === 'revision')) {
        throw new Error(`${id}: git source.revision must be a full commit hash`)
      }
      throw new Error(parsed.error.issues[0]!.message)
    }
    return {
      type: 'git', url: parsed.data.url,
      revision: parsed.data.revision,
      tracking_ref: parsed.data.tracking_ref,
      path: parsed.data.path ? safeRelativePath(String(parsed.data.path), 'git source path') : undefined,
    }
  }
  throw new Error(`${id}: unsupported source type ${String(data.type)}`)
}

export function parseSkillRegistryDefinition(raw: unknown): SkillRegistryDefinition {
  const data = object(raw, 'Registry definition')
  const id = assertRegistryID(String(data.id ?? '').trim(), 'registry ID')
  const parsed = z.strictObject({
    schema_version: z.unknown(),
    id: z.unknown(),
    name: z.pipe(z.string(), z.transform((value) => value.trim())).check(z.minLength(1)),
    enabled: z.optional(z.unknown()),
    priority: z.optional(z.unknown()),
    adapter: z.unknown(),
    source: z.unknown(),
  }, {
    error: (issue) => issue.code === 'unrecognized_keys'
      ? `${id}: unsupported Registry field ${(issue as { keys: string[] }).keys.join(', ')}`
      : undefined,
  }).safeParse(data)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!
    if (issue.code === 'unrecognized_keys') throw new Error(issue.message)
    if (issue.path[0] === 'name') throw new Error(`${id}: name is required`)
    throw new Error(issue.message)
  }
  if (data.schema_version !== '1') throw new Error(`${id}: unsupported schema_version ${String(data.schema_version)}`)
  return {
    schema_version: '1', id, name: parsed.data.name,
    enabled: data.enabled !== false,
    priority: Number.isFinite(Number(data.priority)) ? Number(data.priority) : 0,
    adapter: parseAdapter(data.adapter, id),
    source: parseSource(data.source, id),
  }
}
