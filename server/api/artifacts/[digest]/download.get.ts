import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam, setResponseHeader } from 'h3'
import { getRuntimeSkillRegistryStore } from '../../../utils/skill-registry-loader'

export default defineHandler(async (event) => {
  const digest = getRouterParam(event, 'digest')!
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new HTTPError('Invalid artifact digest', { statusCode: 400 })
  const artifact = await (await getRuntimeSkillRegistryStore(event)).getArtifact(digest)
  if (!artifact) throw new HTTPError(`Artifact "${digest}" not found`, { statusCode: 404 })
  setResponseHeader(event, 'content-type', artifact.descriptor.content_type)
  setResponseHeader(event, 'content-length', String(artifact.bytes.length))
  setResponseHeader(event, 'content-disposition', `attachment; filename="${digest}.tar.gz"`)
  setResponseHeader(event, 'etag', `"${digest}"`)
  setResponseHeader(event, 'x-content-sha256', digest)
  setResponseHeader(event, 'cache-control', 'public, max-age=31536000, immutable')
  return artifact.bytes
})
