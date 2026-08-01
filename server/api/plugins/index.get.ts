import { defineHandler } from 'nitro'
import { getValidatedQuery } from 'h3'
import { getAllPlugins } from '#server/services/plugin'
import { parsePluginQuery } from '#server/services/plugin-query'

export default defineHandler(async (event) => getAllPlugins(
  event,
  await getValidatedQuery(event, parsePluginQuery),
))
