import path from 'node:path'
import * as z from 'zod/mini'
import type {
  SkillRegistryDefinition,
  SkillRuntimeOS,
  SkillRuntimeRequirements,
} from './types'

export const supportedSkillRuntimeOS: SkillRuntimeOS[] = ['darwin', 'linux', 'win32']
const runtimeOS = new Set<string>(supportedSkillRuntimeOS)
const safeIDPattern = /^[a-z0-9][a-z0-9._-]*$/
const maxRefreshIntervalSeconds = 365 * 24 * 60 * 60

function unsupportedFieldError(label: string) {
  return { error: (issue: z.core.$ZodRawIssue) => issue.code === 'unrecognized_keys'
    ? `${label} contains unsupported field ${(issue as { keys: string[] }).keys.join(', ')}`
    : undefined }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

export function assertRegistryID(value: string, label = 'ID'): string {
  if (!safeIDPattern.test(value)) throw new Error(`Invalid ${label}: ${value}`)
  return value
}

export function skillInstallID(registryID: string, packageID: string, skillID: string): string {
  return [
    assertRegistryID(registryID, 'registry ID'),
    assertRegistryID(packageID, 'package ID'),
    assertRegistryID(skillID, 'skill ID'),
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

function parseRefreshInterval(raw: unknown, label: string): number {
  if (typeof raw !== 'string') throw new Error(`${label} must be a duration such as 30m, 12h, or 1d`)
  const match = raw.trim().toLowerCase().match(/^(\d+)([smhd])$/)
  if (!match) throw new Error(`${label} must be a duration such as 30m, 12h, or 1d`)
  const amount = Number(match[1])
  const multiplier = { s: 1, m: 60, h: 3_600, d: 86_400 }[match[2]!]!
  const seconds = amount * multiplier
  if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > maxRefreshIntervalSeconds) {
    throw new Error(`${label} must be between 1m and 365d`)
  }
  return seconds
}

function parseRetention(raw: unknown, registryID: string): SkillRegistryDefinition['retention'] {
  if (raw == null) return { snapshots: 30 }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${registryID}.retention must be an object`)
  }
  const parsed = z.strictObject({
    snapshots: z.number().check(z.int(), z.minimum(1), z.maximum(10_000)),
  }, {
    error: (issue) => issue.code === 'unrecognized_keys' ? `${registryID}.retention contains unsupported fields` : undefined,
  }).safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!
    if (issue.code === 'unrecognized_keys') throw new Error(issue.message)
    throw new Error(`${registryID}.retention.snapshots must be an integer from 1 to 10000`)
  }
  return { snapshots: parsed.data.snapshots }
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
      ref: z.optional(z.string()),
      path: z.optional(z.string()),
    }, unsupportedFieldError(`${id}: git source`)).safeParse(data)
    if (!parsed.success) throw new Error(parsed.error.issues[0]!.message)
    return {
      type: 'git', url: parsed.data.url,
      ref: parsed.data.ref ? String(parsed.data.ref) : undefined,
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
    refresh_interval: z.optional(z.unknown()),
    retention: z.optional(z.unknown()),
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
    refresh_interval_seconds: parseRefreshInterval(data.refresh_interval, `${id}.refresh_interval`),
    retention: parseRetention(data.retention, id),
  }
}
