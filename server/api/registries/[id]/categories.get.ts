import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'h3'
import { getSkillCategories, getSkillRegistryDetails } from '../../../utils/skill-registry-loader'

export default defineHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  if (!await getSkillRegistryDetails(event, id)) throw new HTTPError(`Registry "${id}" not found`, { statusCode: 404 })
  return { data: await getSkillCategories(event, id) }
})
