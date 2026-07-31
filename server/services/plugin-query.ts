import { positiveIntegerQuery, scalarQuery } from './query'

export interface PluginSearchOptions {
  q?: string
  tag?: string
  page?: number
  limit?: number
}

export function parsePluginQuery(query: Record<string, unknown>): PluginSearchOptions {
  return {
    q: scalarQuery(query, 'q'),
    tag: scalarQuery(query, 'tag'),
    page: positiveIntegerQuery(scalarQuery(query, 'page'), 'page'),
    limit: positiveIntegerQuery(scalarQuery(query, 'limit'), 'limit', 100),
  }
}
