import { defineHandler, HTTPError } from 'nitro'
import { getHeader, getRouterParam, setResponseHeader, setResponseStatus } from 'h3'
import { assertDigest } from '#registry/storage/validation'
import { requireRegistryComponentID, requireRegistryID } from '#server/services/skill-registry-query'
import { getSkillPackageRelease } from '#server/services/skill-registry'

const encoder = new TextEncoder()

export default defineHandler(async (event) => {
  const registryID = requireRegistryID(getRouterParam(event, 'id')!)
  const packageID = requireRegistryComponentID(getRouterParam(event, 'packageId')!, 'package ID')
  let revision: string
  try {
    revision = assertDigest(getRouterParam(event, 'revision')!)
  } catch {
    throw new HTTPError('Invalid Package release revision', { statusCode: 400 })
  }
  const descriptor = await getSkillPackageRelease(event, registryID, packageID, revision)
  if (!descriptor) {
    throw new HTTPError(`Package release "${registryID}/${packageID}/${revision}" not found`, { statusCode: 404 })
  }

  const bytes = encoder.encode(`${JSON.stringify(descriptor, null, 2)}\n`)
  const etag = `"${revision}:${packageID}"`
  setResponseHeader(event, 'content-type', 'application/json; charset=utf-8')
  setResponseHeader(event, 'content-length', String(bytes.length))
  setResponseHeader(event, 'etag', etag)
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
