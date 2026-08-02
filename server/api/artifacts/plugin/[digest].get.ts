import { defineHandler, HTTPError } from 'nitro'
import { getHeader, getRouterParam, setResponseHeader, setResponseStatus } from 'h3'
import { getRuntimePluginReleaseStore } from '#server/services/plugin'

export default defineHandler(async (event) => {
  const digest = getRouterParam(event, 'digest')!
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new HTTPError('Invalid artifact digest', { statusCode: 400 })
  const etag = `"${digest}"`
  const validators = (getHeader(event, 'if-none-match') ?? '').split(',').map((value) => value.trim().replace(/^W\//, ''))
  if (validators.includes('*') || validators.includes(etag)) {
    setResponseHeader(event, 'etag', etag)
    setResponseHeader(event, 'cache-control', 'public, max-age=31536000, immutable')
    setResponseStatus(event, 304)
    return null
  }
  const store = await getRuntimePluginReleaseStore(event)
  const artifact = await store.getArtifactStream(digest)
  if (!artifact) throw new HTTPError(`Plugin Artifact "${digest}" not found`, { statusCode: 404 })
  setResponseHeader(event, 'content-type', artifact.descriptor.content_type)
  setResponseHeader(event, 'content-length', String(artifact.descriptor.size))
  setResponseHeader(event, 'content-disposition', `attachment; filename="${digest}.tar.gz"`)
  setResponseHeader(event, 'etag', etag)
  setResponseHeader(event, 'x-content-sha256', digest)
  setResponseHeader(event, 'cache-control', 'public, max-age=31536000, immutable')
  return artifact.body
})
