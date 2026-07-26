import { defineHandler, HTTPError } from 'nitro'
import { getHeader, getRouterParam, setResponseHeader, setResponseStatus } from 'h3'
import { getRuntimeSkillRegistryStore } from '../../utils/skill-registry-loader'

export default defineHandler(async (event) => {
  const digest = getRouterParam(event, 'digest')!
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new HTTPError('Invalid Skill image digest', { statusCode: 400 })
  const store = await getRuntimeSkillRegistryStore(event)
  const skillImage = store.getImageStream
    ? await store.getImageStream(digest)
    : await store.getImage(digest).then((value) => value && ({ descriptor: value.descriptor, body: value.bytes }))
  if (!skillImage) throw new HTTPError(`Skill image "${digest}" not found`, { statusCode: 404 })
  const etag = `"${digest}"`
  setResponseHeader(event, 'content-type', skillImage.descriptor.content_type)
  setResponseHeader(event, 'content-length', String(skillImage.descriptor.size))
  setResponseHeader(event, 'etag', etag)
  setResponseHeader(event, 'x-content-sha256', digest)
  setResponseHeader(event, 'cache-control', 'public, max-age=31536000, immutable')
  setResponseHeader(event, 'content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
  setResponseHeader(event, 'x-content-type-options', 'nosniff')
  const validators = (getHeader(event, 'if-none-match') ?? '').split(',').map((value) => value.trim().replace(/^W\//, ''))
  if (validators.includes('*') || validators.includes(etag)) {
    setResponseStatus(event, 304)
    return null
  }
  return skillImage.body
})
