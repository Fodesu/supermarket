import { HTTPError } from 'nitro'
import * as z from 'zod/mini'
import type { SkillCatalogSearchOptions } from '#registry/catalog'
import { assertIdentifier, assertRegistryComponentID, assertRegistryID, isSkillRuntimeOS } from '#registry/definition'
import { positiveIntegerQuery, scalarQuery } from './query'

function badRequest(message: string): never {
  throw new HTTPError(message, { statusCode: 400 })
}

export function requireSkillRegistryID(value: string, label: string) {
  try {
    return assertIdentifier(value, label)
  } catch {
    return badRequest(`Invalid ${label}: ${value}`)
  }
}

export function requireRegistryComponentID(value: string, label: string) {
  try {
    return assertRegistryComponentID(value, label)
  } catch {
    return badRequest(`Invalid ${label}: ${value}`)
  }
}

export function requireRegistryID(value: string) {
  try {
    return assertRegistryID(value)
  } catch {
    return badRequest(`Invalid registry ID: ${value}`)
  }
}

export function parseSkillRegistryQuery(query: Record<string, unknown>, registry?: string): SkillCatalogSearchOptions {
  const registryValue = registry ?? scalarQuery(query, 'registry')
  const packageValue = scalarQuery(query, 'package')
  const category = scalarQuery(query, 'category')
  const os = scalarQuery(query, 'os')
  const normalizedOS = os?.toLowerCase()
  const sortValue = scalarQuery(query, 'sort')
  const sort = z.optional(z.enum(['relevance', 'name', 'registry', 'package']))
  if (!sort.safeParse(sortValue).success) badRequest(`Unsupported sort: ${sortValue}`)
  if (normalizedOS != null && !isSkillRuntimeOS(normalizedOS)) badRequest(`Unsupported os: ${os}`)
  return {
    registry: registryValue != null ? requireRegistryID(registryValue) : undefined,
    q: scalarQuery(query, 'q'),
    package: packageValue != null ? requireRegistryComponentID(packageValue, 'package ID') : undefined,
    category: category != null ? requireSkillRegistryID(category.toLowerCase(), 'category ID') : undefined,
    tag: scalarQuery(query, 'tag'),
    os: normalizedOS,
    page: positiveIntegerQuery(scalarQuery(query, 'page'), 'page'),
    limit: positiveIntegerQuery(scalarQuery(query, 'limit'), 'limit', 100),
    sort: sortValue as SkillCatalogSearchOptions['sort'],
  }
}
