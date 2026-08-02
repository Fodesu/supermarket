import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'h3'
import { requireIdentifier } from '#server/services/skill-registry-query'
import { getPluginById } from '#server/services/plugin'

export default defineHandler(async (event) => {
  const id = requireIdentifier(getRouterParam(event, 'id')!, 'plugin ID')

  const plugin = await getPluginById(event, id)
  if (!plugin) {
    throw new HTTPError(`Plugin "${id}" not found`, { statusCode: 404 })
  }

  return plugin
})
