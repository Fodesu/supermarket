import { defineHandler, HTTPError } from 'nitro'
import {
  getHeader,
  getRouterParam,
  setResponseHeader,
  setResponseStatus,
} from 'h3'
import { assertDigest } from '#registry/storage/validation'
import { requireIdentifier } from '#server/services/skill-registry-query'
import { getPluginReleaseBytes } from '#server/services/plugin'

export default defineHandler(async (event) => {
  const id = requireIdentifier(getRouterParam(event, 'id')!, 'plugin ID')
  let revision: string
  try {
    revision = assertDigest(getRouterParam(event, 'revision')!)
  } catch {
    throw new HTTPError('Invalid Plugin release revision', { statusCode: 400 })
  }
  const bytes = await getPluginReleaseBytes(event, id, revision)
  if (!bytes) throw new HTTPError(`Plugin release "${id}/${revision}" not found`, { statusCode: 404 })

  const etag = `"${revision}"`
  setResponseHeader(event, 'content-type', 'application/json; charset=utf-8')
  setResponseHeader(event, 'content-length', String(bytes.length))
  setResponseHeader(event, 'etag', etag)
  setResponseHeader(event, 'x-content-sha256', revision)
  setResponseHeader(event, 'cache-control', 'public, max-age=31536000, immutable')
  const validators = (getHeader(event, 'if-none-match') ?? '')
    .split(',')
    .map((value) => value.trim().replace(/^W\//, ''))
  if (validators.includes('*') || validators.includes(etag)) {
    setResponseStatus(event, 304)
    return null
  }
  return bytes
})
