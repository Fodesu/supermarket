import { defineHandler, HTTPError } from 'nitro'
import { getQuery, getRouterParam } from 'h3'
import { parseSkillRegistryQuery, requireSkillRegistryID } from '#server/services/skill-registry-query'
import { getCatalogSkills, getSkillRegistryDetails } from '#server/services/skill-registry'

export default defineHandler(async (event) => {
  const id = requireSkillRegistryID(getRouterParam(event, 'id')!, 'registry ID')
  if (!await getSkillRegistryDetails(event, id)) throw new HTTPError(`Registry "${id}" not found`, { statusCode: 404 })
  return getCatalogSkills(event, parseSkillRegistryQuery(getQuery(event), id))
})
