import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'h3'
import { getSkillRegistryDetails } from '../../utils/skill-registry-loader'

export default defineHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const registry = await getSkillRegistryDetails(event, id)
  if (!registry) throw new HTTPError(`Registry "${id}" not found`, { statusCode: 404 })
  return registry
})
