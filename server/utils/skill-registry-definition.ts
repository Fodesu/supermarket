import path from 'node:path'
import type {
  SkillRegistryAdapter,
  SkillRegistryDefinition,
  SkillRegistrySource,
  SkillRuntimeOS,
  SkillRuntimeRequirements,
} from '../types/skill-registry'

const adapters = new Set<SkillRegistryAdapter>(['skill_directory', 'codex_marketplace_skills'])
export const supportedSkillRuntimeOS: SkillRuntimeOS[] = ['darwin', 'linux', 'win32']
const runtimeOS = new Set<string>(supportedSkillRuntimeOS)
const safeIDPattern = /^[a-z0-9][a-z0-9._-]*$/

export function assertRegistryID(value: string, label = 'ID'): string {
  if (!safeIDPattern.test(value)) throw new Error(`Invalid ${label}: ${value}`)
  return value
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
  if (!raw || typeof raw !== 'object') throw new Error(`${label} must be an object`)
  const data = raw as Record<string, unknown>
  if (!Array.isArray(data.os) || data.os.length === 0) throw new Error(`${label}.os must be a non-empty array`)
  const values = data.os.map((item) => String(item).toLowerCase().trim())
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
  if (!Number.isSafeInteger(seconds) || seconds < 60) throw new Error(`${label} must be at least 1m`)
  return seconds
}

function parseOverrides(raw: unknown, registryID: string, kind: 'package' | 'skill') {
  if (raw == null) return undefined
  if (!raw || typeof raw !== 'object') throw new Error(`${registryID}.${kind}_overrides must be an object`)
  const overrides: Record<string, { runtime_requirements?: SkillRuntimeRequirements }> = {}
  for (const [key, value] of Object.entries(raw as Record<string, any>)) {
    const parts = kind === 'skill' ? key.split('/') : [key]
    if (parts.length !== (kind === 'skill' ? 2 : 1) || parts.some((part) => !safeIDPattern.test(part))) {
      throw new Error(`${registryID}: invalid ${kind} override id: ${key}`)
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || !Object.hasOwn(value, 'runtime_requirements')
      || Object.keys(value).some((field) => field !== 'runtime_requirements')) {
      throw new Error(`${registryID}.${kind}_overrides.${key} must contain only runtime_requirements`)
    }
    overrides[key] = {
      runtime_requirements: parseRuntimeRequirements(
        value?.runtime_requirements,
        `${registryID}.${kind}_overrides.${key}.runtime_requirements`,
      ),
    }
  }
  return Object.keys(overrides).length ? overrides : undefined
}

function parseTaxonomy(raw: unknown, registryID: string): SkillRegistryDefinition['taxonomy'] {
  if (raw == null) return undefined
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${registryID}.taxonomy must be an object`)
  }
  const mappingsRaw = (raw as Record<string, unknown>).mappings
  if (mappingsRaw == null) return undefined
  if (!mappingsRaw || typeof mappingsRaw !== 'object' || Array.isArray(mappingsRaw)) {
    throw new Error(`${registryID}.taxonomy.mappings must be an object`)
  }
  const mappings: Record<string, string> = {}
  for (const [source, target] of Object.entries(mappingsRaw as Record<string, unknown>)) {
    const sourceName = source.trim()
    const categoryID = typeof target === 'string' ? target.trim() : ''
    if (!sourceName || !safeIDPattern.test(categoryID)) {
      throw new Error(`${registryID}: invalid taxonomy mapping ${source}: ${String(target)}`)
    }
    mappings[sourceName] = categoryID
  }
  return Object.keys(mappings).length ? { mappings } : undefined
}

export function resolveSkillRuntimeRequirements(
  definition: SkillRegistryDefinition,
  packageID: string,
  skillID: string,
  declared?: unknown,
): SkillRuntimeRequirements {
  return definition.skill_overrides?.[`${packageID}/${skillID}`]?.runtime_requirements
    ?? definition.package_overrides?.[packageID]?.runtime_requirements
    ?? parseRuntimeRequirements(declared, `${definition.id}/${packageID}/${skillID}.runtime_requirements`)
    ?? definition.defaults?.runtime_requirements
    ?? { os: [...supportedSkillRuntimeOS] }
}

export function parseSkillRegistryDefinition(raw: unknown): SkillRegistryDefinition {
  if (!raw || typeof raw !== 'object') throw new Error('Registry definition must be an object')
  const data = raw as Record<string, any>
  const id = assertRegistryID(String(data.id ?? '').trim(), 'registry ID')
  if (data.schema_version !== '1') throw new Error(`${id}: unsupported schema_version ${String(data.schema_version)}`)
  const name = String(data.name ?? '').trim()
  const adapter = String(data.adapter ?? '') as SkillRegistryAdapter
  if (!name) throw new Error(`${id}: name is required`)
  if (!adapters.has(adapter)) throw new Error(`${id}: unsupported adapter ${adapter}`)

  const sourceData = data.source
  if (!sourceData || typeof sourceData !== 'object') throw new Error(`${id}: source is required`)
  let source: SkillRegistrySource
  if (sourceData.type === 'local') {
    if (typeof sourceData.path !== 'string' || !sourceData.path.trim()) {
      throw new Error(`${id}: local source.path is required`)
    }
    const localPath = sourceData.path.trim()
    source = { type: 'local', path: localPath === '.' ? '' : safeRelativePath(localPath, 'local source path') }
  } else if (sourceData.type === 'git') {
    const url = String(sourceData.url ?? '').trim()
    if (!/^https:\/\//.test(url) && !/^ssh:\/\//.test(url) && !/^git@/.test(url)) {
      throw new Error(`${id}: invalid git source URL`)
    }
    source = {
      type: 'git', url,
      ref: sourceData.ref ? String(sourceData.ref) : undefined,
      path: sourceData.path ? safeRelativePath(String(sourceData.path), 'git source path') : undefined,
    }
  } else {
    throw new Error(`${id}: unsupported source type ${String(sourceData.type)}`)
  }

  const catalogPath = data.catalog_path ? safeRelativePath(String(data.catalog_path), 'catalog path') : undefined
  if (adapter === 'codex_marketplace_skills' && !catalogPath) {
    throw new Error(`${id}: catalog_path is required for ${adapter}`)
  }
  const defaultRequirements = parseRuntimeRequirements(
    data.defaults?.runtime_requirements,
    `${id}.defaults.runtime_requirements`,
  )
  return {
    schema_version: '1', id, name,
    enabled: data.enabled !== false,
    priority: Number.isFinite(Number(data.priority)) ? Number(data.priority) : 0,
    adapter, source, catalog_path: catalogPath,
    refresh_interval_seconds: parseRefreshInterval(data.refresh_interval, `${id}.refresh_interval`),
    taxonomy: parseTaxonomy(data.taxonomy, id),
    defaults: defaultRequirements ? { runtime_requirements: defaultRequirements } : undefined,
    package_overrides: parseOverrides(data.package_overrides, id, 'package'),
    skill_overrides: parseOverrides(data.skill_overrides, id, 'skill'),
  }
}
