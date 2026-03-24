import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { McpConfig, McpEntry } from '../types/mcp'

const mcpsDir = resolve(process.env.MCPS_DIR || join(process.cwd(), 'mcps'))

let cache: McpEntry[] | null = null

async function scanMcps(): Promise<McpEntry[]> {
  const entries: McpEntry[] = []

  let dirs: string[]
  try {
    dirs = await readdir(mcpsDir)
  } catch {
    return entries
  }

  for (const dir of dirs) {
    const yamlPath = join(mcpsDir, dir, 'mcp.yaml')
    try {
      const text = await readFile(yamlPath, 'utf-8')
      const data = parseYaml(text) as McpConfig
      entries.push({ ...data, id: dir })
    } catch {
      // skip invalid entries
    }
  }

  return entries
}

async function getCache(): Promise<McpEntry[]> {
  if (!cache) {
    cache = await scanMcps()
  }
  return cache
}

export function invalidateMcpCache() {
  cache = null
}

export async function getAllMcps(options?: {
  q?: string
  transport?: string
  page?: number
  limit?: number
}) {
  const all = await getCache()
  let filtered = all

  if (options?.transport) {
    filtered = filtered.filter((m) => m.transport === options.transport)
  }

  if (options?.q) {
    const q = options.q.toLowerCase()
    filtered = filtered.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.description.toLowerCase().includes(q) ||
        m.tags?.some((t) => t.toLowerCase().includes(q)),
    )
  }

  const page = options?.page ?? 1
  const limit = options?.limit ?? 20
  const start = (page - 1) * limit

  return {
    total: filtered.length,
    page,
    limit,
    data: filtered.slice(start, start + limit),
  }
}

export async function getMcpById(id: string): Promise<McpEntry | undefined> {
  const all = await getCache()
  return all.find((m) => m.id === id)
}
