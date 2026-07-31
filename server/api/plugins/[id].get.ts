import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'h3'
import { requireSkillRegistryID } from '#server/services/skill-registry-query'
import { getPluginById } from '#server/services/plugin'

export default defineHandler(async (event) => {
  const id = requireSkillRegistryID(getRouterParam(event, 'id')!, 'plugin ID')

  const plugin = await getPluginById(id)
  if (!plugin) {
    throw new HTTPError(`Plugin "${id}" not found`, { statusCode: 404 })
  }

  return plugin
})
