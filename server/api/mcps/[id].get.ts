import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'h3'
import { getMcpById } from '../../utils/mcp-loader'

export default defineHandler(async (event) => {
  const id = getRouterParam(event, 'id')!

  const mcp = await getMcpById(id)
  if (!mcp) {
    throw new HTTPError(`MCP "${id}" not found`, { statusCode: 404 })
  }

  return mcp
})
