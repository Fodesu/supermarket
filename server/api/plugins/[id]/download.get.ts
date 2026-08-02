import { defineHandler, HTTPError } from 'nitro'
import { getHeader, getRouterParam, setResponseHeader, setResponseStatus } from 'h3'
import { requireIdentifier } from '#server/services/skill-registry-query'
import { getPluginDownload } from '#server/services/plugin'

export default defineHandler(async (event) => {
  const id = requireIdentifier(getRouterParam(event, 'id')!, 'plugin ID')
  const artifact = await getPluginDownload(event, id)
  if (!artifact) throw new HTTPError(`Plugin "${id}" not found`, { statusCode: 404 })

  const digest = artifact.descriptor.digest
  const etag = `"${digest}"`
  setResponseHeader(event, 'content-type', artifact.descriptor.content_type)
  setResponseHeader(event, 'content-length', String(artifact.descriptor.size))
  setResponseHeader(event, 'content-disposition', `attachment; filename="${id}.tar.gz"`)
  setResponseHeader(event, 'etag', etag)
  setResponseHeader(event, 'x-content-sha256', digest)
  setResponseHeader(event, 'x-plugin-release', artifact.revision)
  setResponseHeader(event, 'cache-control', 'no-cache')
  const validators = (getHeader(event, 'if-none-match') ?? '').split(',').map((value) => value.trim().replace(/^W\//, ''))
  if (validators.includes('*') || validators.includes(etag)) {
    setResponseStatus(event, 304)
    return null
  }
  return artifact.body
})
