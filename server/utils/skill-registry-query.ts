import { HTTPError } from 'nitro'
import type { SkillCatalogSearchOptions } from './skill-catalog-search'
import { assertRegistryID, supportedSkillRuntimeOS } from './skill-registry-definition'

function badRequest(message: string): never {
  throw new HTTPError(message, { statusCode: 400 })
}

function scalar(query: Record<string, unknown>, name: string) {
  const value = query[name]
  if (value == null) return undefined
  if (typeof value !== 'string') badRequest(`Query parameter "${name}" must be specified once`)
  return value.trim()
}

export function requireSkillRegistryID(value: string, label: string) {
  try {
    return assertRegistryID(value, label)
  } catch {
    return badRequest(`Invalid ${label}: ${value}`)
  }
}

function positiveInteger(value: string | undefined, name: string, maximum?: number) {
  if (value == null) return undefined
  if (!/^\d+$/.test(value)) badRequest(`Query parameter "${name}" must be a positive integer`)
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1 || (maximum != null && number > maximum)) {
    badRequest(`Query parameter "${name}" is out of range`)
  }
  return number
}

export function parseSkillRegistryQuery(query: Record<string, unknown>, registry?: string): SkillCatalogSearchOptions {
  const registryValue = registry ?? scalar(query, 'registry')
  const packageValue = scalar(query, 'package')
  const category = scalar(query, 'category')
  const os = scalar(query, 'os')
  const sortValue = scalar(query, 'sort')
  if (sortValue && !['relevance', 'name', 'registry', 'package'].includes(sortValue)) {
    badRequest(`Unsupported sort: ${sortValue}`)
  }
  if (os && !supportedSkillRuntimeOS.includes(os.toLowerCase() as any)) badRequest(`Unsupported os: ${os}`)
  return {
    registry: registryValue != null ? requireSkillRegistryID(registryValue, 'registry ID') : undefined,
    q: scalar(query, 'q'),
    package: packageValue != null ? requireSkillRegistryID(packageValue, 'package ID') : undefined,
    category: category != null ? requireSkillRegistryID(category.toLowerCase(), 'category ID') : undefined,
    tag: scalar(query, 'tag'),
    os: os?.toLowerCase(),
    page: positiveInteger(scalar(query, 'page'), 'page'),
    limit: positiveInteger(scalar(query, 'limit'), 'limit', 100),
    sort: sortValue as SkillCatalogSearchOptions['sort'],
  }
}
