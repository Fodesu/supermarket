import { defineHandler, HTTPError } from 'nitro'
import { getQuery, getRouterParam } from 'h3'
import { getCatalogSkills, getSkillRegistryDetails } from '../../../../utils/skill-registry-loader'
import { parseSkillRegistryQuery } from '../../../../utils/skill-registry-query'

export default defineHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  if (!await getSkillRegistryDetails(event, id)) throw new HTTPError(`Registry "${id}" not found`, { statusCode: 404 })
  return getCatalogSkills(event, parseSkillRegistryQuery(getQuery(event), id))
})
