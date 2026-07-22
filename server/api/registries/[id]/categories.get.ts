import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'h3'
import { getSkillCategories, getSkillRegistryDetails } from '../../../utils/skill-registry-loader'
import { requireSkillRegistryID } from '../../../utils/skill-registry-query'

export default defineHandler(async (event) => {
  const id = requireSkillRegistryID(getRouterParam(event, 'id')!, 'registry ID')
  if (!await getSkillRegistryDetails(event, id)) throw new HTTPError(`Registry "${id}" not found`, { statusCode: 404 })
  return { data: await getSkillCategories(event, id) }
})
