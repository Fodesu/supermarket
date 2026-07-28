import { defineHandler } from 'nitro'
import { getQuery } from 'h3'
import { getAllPlugins } from '#server/services/plugin'
import { parsePluginQuery } from '#server/services/plugin-query'

export default defineHandler(async (event) => getAllPlugins(parsePluginQuery(getQuery(event))))
