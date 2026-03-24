import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam, getQuery, setResponseHeader } from 'h3'
import { stringify as stringifyYaml } from 'yaml'
import { getMcpById } from '../../../utils/mcp-loader'

export default defineHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const query = getQuery(event)
  const format = (query.format as string) || 'yaml'

  const mcp = await getMcpById(id)
  if (!mcp) {
    throw new HTTPError(`MCP "${id}" not found`, { statusCode: 404 })
  }

  const { id: _id, ...config } = mcp

  if (format === 'json') {
    setResponseHeader(event, 'content-disposition', `attachment; filename="${id}.json"`)
    return config
  }

  const yamlContent = stringifyYaml(config)
  setResponseHeader(event, 'content-type', 'application/x-yaml')
  setResponseHeader(event, 'content-disposition', `attachment; filename="${id}.yaml"`)
  return yamlContent
})
