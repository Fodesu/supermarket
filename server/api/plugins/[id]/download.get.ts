import { defineHandler, HTTPError } from 'nitro'
import { getHeader, getRouterParam, setResponseHeader, setResponseStatus } from 'h3'
import { requireIdentifier } from '#server/services/skill-registry-query'
import {
  getPluginDownloadDescriptor,
  getRuntimePluginReleaseStore,
} from '#server/services/plugin'

export default defineHandler(async (event) => {
  const id = requireIdentifier(getRouterParam(event, 'id')!, 'plugin ID')
  const download = await getPluginDownloadDescriptor(event, id)
  if (!download) throw new HTTPError(`Plugin "${id}" not found`, { statusCode: 404 })

  const digest = download.descriptor.digest
  const etag = `"${digest}"`
  setResponseHeader(event, 'content-type', download.descriptor.content_type)
  setResponseHeader(event, 'content-length', String(download.descriptor.size))
  setResponseHeader(event, 'content-disposition', `attachment; filename="${id}.tar.gz"`)
  setResponseHeader(event, 'etag', etag)
  setResponseHeader(event, 'x-content-sha256', digest)
  setResponseHeader(event, 'x-plugin-release', download.revision)
  setResponseHeader(event, 'cache-control', 'no-cache')
  const validators = (getHeader(event, 'if-none-match') ?? '').split(',').map((value) => value.trim().replace(/^W\//, ''))
  if (validators.includes('*') || validators.includes(etag)) {
    setResponseStatus(event, 304)
    return null
  }
  const artifact = await (await getRuntimePluginReleaseStore(event)).getArtifactStream(digest)
  if (!artifact) throw new Error(`Current Plugin Artifact is missing: ${id}/${digest}`)
  if (artifact.descriptor.size !== download.descriptor.size) {
    await artifact.body.cancel()
    throw new Error(`Current Plugin Artifact size does not match its release: ${id}/${digest}`)
  }
  return artifact.body
})
