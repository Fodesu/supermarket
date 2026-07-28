import path from 'node:path'
import type {
  SkillRegistryDefinition,
  SkillRegistrySource,
  SkillRuntimeOS,
  SkillRuntimeRequirements,
} from './types'

export const supportedSkillRuntimeOS: SkillRuntimeOS[] = ['darwin', 'linux', 'win32']
const runtimeOS = new Set<string>(supportedSkillRuntimeOS)
const safeIDPattern = /^[a-z0-9][a-z0-9._-]*$/

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

function parseRetention(raw: unknown, registryID: string): SkillRegistryDefinition['retention'] {
  if (raw == null) return { snapshots: 30 }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${registryID}.retention must be an object`)
  }
  const data = raw as Record<string, unknown>
  if (Object.keys(data).some((field) => field !== 'snapshots')) {
    throw new Error(`${registryID}.retention contains unsupported fields`)
  }
  const snapshots = data.snapshots
  if (typeof snapshots !== 'number' || !Number.isSafeInteger(snapshots)
    || snapshots < 1 || snapshots > 10_000) {
    throw new Error(`${registryID}.retention.snapshots must be an integer from 1 to 10000`)
  }
  return { snapshots }
}

export function resolveSkillRuntimeRequirements(
  definition: SkillRegistryDefinition,
  packageID: string,
  skillID: string,
  declared?: unknown,
): SkillRuntimeRequirements | undefined {
  return parseRuntimeRequirements(declared, `${definition.id}/${packageID}/${skillID}.runtime_requirements`)
}

export function parseSkillRegistryDefinition(raw: unknown): SkillRegistryDefinition {
  if (!raw || typeof raw !== 'object') throw new Error('Registry definition must be an object')
  const data = raw as Record<string, any>
  const id = assertRegistryID(String(data.id ?? '').trim(), 'registry ID')
  const supportedFields = new Set([
    'schema_version', 'id', 'name', 'enabled', 'priority', 'adapter',
    'source', 'refresh_interval', 'retention',
  ])
  const unsupportedField = Object.keys(data).find((field) => !supportedFields.has(field))
  if (unsupportedField) throw new Error(`${id}: unsupported Registry field ${unsupportedField}`)
  if (data.schema_version !== '1') throw new Error(`${id}: unsupported schema_version ${String(data.schema_version)}`)
  const name = String(data.name ?? '').trim()
  if (!name) throw new Error(`${id}: name is required`)
  const adapterData = data.adapter
  if (!adapterData || typeof adapterData !== 'object' || Array.isArray(adapterData)) {
    throw new Error(`${id}: adapter must be an object`)
  }
  const adapterType = String(adapterData.type ?? '')
  let adapter: SkillRegistryDefinition['adapter']
  if (adapterType === 'skill_directory') {
    if (Object.keys(adapterData).some((field) => field !== 'type')) {
      throw new Error(`${id}: skill_directory adapter contains unsupported fields`)
    }
    adapter = { type: 'skill_directory' }
  } else if (adapterType === 'codex_marketplace_skills') {
    if (Object.keys(adapterData).some((field) => !['type', 'catalog_path'].includes(field))) {
      throw new Error(`${id}: codex_marketplace_skills adapter contains unsupported fields`)
    }
    if (typeof adapterData.catalog_path !== 'string' || !adapterData.catalog_path.trim()) {
      throw new Error(`${id}: adapter.catalog_path is required for ${adapterType}`)
    }
    adapter = {
      type: 'codex_marketplace_skills',
      catalog_path: safeRelativePath(adapterData.catalog_path, 'catalog path'),
    }
  } else {
    throw new Error(`${id}: unsupported adapter ${adapterType}`)
  }

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
    if (!/^https:\/\//.test(url)) {
      throw new Error(`${id}: git source URL must use HTTPS`)
    }
    source = {
      type: 'git', url,
      ref: sourceData.ref ? String(sourceData.ref) : undefined,
      path: sourceData.path ? safeRelativePath(String(sourceData.path), 'git source path') : undefined,
    }
  } else {
    throw new Error(`${id}: unsupported source type ${String(sourceData.type)}`)
  }

  return {
    schema_version: '1', id, name,
    enabled: data.enabled !== false,
    priority: Number.isFinite(Number(data.priority)) ? Number(data.priority) : 0,
    adapter, source,
    refresh_interval_seconds: parseRefreshInterval(data.refresh_interval, `${id}.refresh_interval`),
    retention: parseRetention(data.retention, id),
  }
}
