import type { SkillCatalogSearchOptions } from './skill-catalog-search'

export function parseSkillRegistryQuery(query: Record<string, unknown>, registry?: string): SkillCatalogSearchOptions {
  const sort = typeof query.sort === 'string' && ['relevance', 'name', 'registry', 'package'].includes(query.sort)
    ? query.sort as SkillCatalogSearchOptions['sort']
    : undefined
  return {
    registry: registry ?? (typeof query.registry === 'string' ? query.registry : undefined),
    q: typeof query.q === 'string' ? query.q : undefined,
    package: typeof query.package === 'string' ? query.package : undefined,
    category: typeof query.category === 'string' ? query.category : undefined,
    tag: typeof query.tag === 'string' ? query.tag : undefined,
    os: typeof query.os === 'string' ? query.os : undefined,
    page: query.page == null ? undefined : Number(query.page),
    limit: query.limit == null ? undefined : Number(query.limit),
    sort,
  }
}
