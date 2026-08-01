import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'h3'
import { requireRegistryID } from '#server/services/skill-registry-query'
import { getSkillCategories, getSkillRegistryDetails } from '#server/services/skill-registry'

export default defineHandler(async (event) => {
  const id = requireRegistryID(getRouterParam(event, 'id')!)
  if (!await getSkillRegistryDetails(event, id)) throw new HTTPError(`Registry "${id}" not found`, { statusCode: 404 })
  return { data: await getSkillCategories(event, id) }
})
