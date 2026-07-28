import { defineHandler, HTTPError } from 'nitro'
import { getValidatedQuery, getRouterParam } from 'h3'
import { parseSkillRegistryQuery, requireSkillRegistryID } from '#server/services/skill-registry-query'
import { getCatalogSkills, getSkillRegistryDetails } from '#server/services/skill-registry'

export default defineHandler(async (event) => {
  const id = requireSkillRegistryID(getRouterParam(event, 'id')!, 'registry ID')
  if (!await getSkillRegistryDetails(event, id)) throw new HTTPError(`Registry "${id}" not found`, { statusCode: 404 })
  return getCatalogSkills(event, await getValidatedQuery(event, (query: Record<string, unknown>) => parseSkillRegistryQuery(query, id)))
})
