import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'h3'
import { getRuntimePluginReleaseStore } from '#server/services/plugin'
import { immutableArtifactResponse } from '#server/services/immutable-artifact-response'

export default defineHandler(async (event) => {
  const digest = getRouterParam(event, 'digest')!
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new HTTPError('Invalid artifact digest', { statusCode: 400 })
  const store = await getRuntimePluginReleaseStore(event)
  const artifact = await store.getArtifactStream(digest)
  if (!artifact) throw new HTTPError(`Plugin Artifact "${digest}" not found`, { statusCode: 404 })
  return immutableArtifactResponse(event, artifact, { filename: `${digest}.tar.gz` })
})
