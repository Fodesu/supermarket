import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam, setResponseHeader } from 'h3'
import { useStorage } from 'nitro/storage'
import { getMcpById } from '../../../utils/mcp-loader'

const MIME: Record<string, string> = {
  svg: 'image/svg+xml',
  png: 'image/png',
  ico: 'image/x-icon',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

export default defineHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const mcp = await getMcpById(id)
  if (!mcp) {
    throw new HTTPError(`MCP "${id}" not found`, { statusCode: 404 })
  }

  const storage = useStorage('assets/mcps')
  const allKeys = await storage.getKeys(`${id}:`)
  const iconKey = allKeys.find((k) => k.match(new RegExp(`^${id}:icon\\.(svg|png|ico|jpg|jpeg|webp)$`)))
  if (!iconKey) {
    throw new HTTPError(`Icon not found for "${id}"`, { statusCode: 404 })
  }

  const ext = iconKey.split('.').pop()?.toLowerCase() || ''
  const contentType = MIME[ext] || 'application/octet-stream'

  setResponseHeader(event, 'content-type', contentType)
  setResponseHeader(event, 'cache-control', 'public, max-age=604800, immutable')

  return await storage.getItemRaw(iconKey)
})
