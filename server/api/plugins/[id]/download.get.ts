import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam, setResponseHeader } from 'h3'
import { requireSkillRegistryID } from '#server/services/skill-registry-query'
import { getPluginById, getPluginFiles } from '#server/services/plugin'
import { createTar, gzip } from '#lib/archive'

export default defineHandler(async (event) => {
  const id = requireSkillRegistryID(getRouterParam(event, 'id')!, 'plugin ID')

  const plugin = await getPluginById(id)
  if (!plugin) {
    throw new HTTPError(`Plugin "${id}" not found`, { statusCode: 404 })
  }

  const files = await getPluginFiles(id)
  const tar = await createTar(files, id)
  const compressed = await gzip(tar)

  setResponseHeader(event, 'content-type', 'application/gzip')
  setResponseHeader(event, 'content-disposition', `attachment; filename="${id}.tar.gz"`)
  return compressed
})
