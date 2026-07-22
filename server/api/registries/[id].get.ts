import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'h3'
import { getSkillRegistryDetails } from '../../utils/skill-registry-loader'
import { requireSkillRegistryID } from '../../utils/skill-registry-query'

export default defineHandler(async (event) => {
  const id = requireSkillRegistryID(getRouterParam(event, 'id')!, 'registry ID')
  const registry = await getSkillRegistryDetails(event, id)
  if (!registry) throw new HTTPError(`Registry "${id}" not found`, { statusCode: 404 })
  return registry
})
