import { useStorage } from 'nitro/storage'
import { stringify as stringifyYaml } from 'yaml'
import { parseBundledSkillDocument, parsePluginManifest } from '#plugin/manifest'
import type { BundledPluginSkill, PluginEntry } from '#plugin/types'

let cache: PluginEntry[] | null = null

const bundledPluginAssetPrefixes = ['skills:', 'scripts:']

async function readBundledSkills(pluginID: string) {
  const storage = useStorage('assets/plugins')
  const allKeys = await storage.getKeys()
  const prefix = `${pluginID}:skills:`
  const skillIds = new Set<string>()

  for (const key of allKeys) {
    if (!key.startsWith(prefix)) continue
    const parts = key.substring(prefix.length).split(':')
    if (parts[0]) skillIds.add(parts[0])
  }

  const skills: BundledPluginSkill[] = []
  for (const skillID of skillIds) {
    const baseKey = `${prefix}${skillID}:`
    const skillMdKey = `${baseKey}SKILL.md`
    const text = (await storage.getItem(skillMdKey)) as string
    if (!text) throw new Error(`${pluginID}/${skillID}: missing SKILL.md`)
    const files = allKeys
      .filter((key) => key.startsWith(baseKey))
      .map((key) => key.substring(baseKey.length).replaceAll(':', '/'))
    skills.push({ ...parseBundledSkillDocument(`${pluginID}/${skillID}`, text), id: skillID, files })
  }
  return skills
}

async function scanExplicitPlugins(): Promise<PluginEntry[]> {
  const storage = useStorage('assets/plugins')
  const allKeys = await storage.getKeys()
  const manifestKeys = allKeys.filter((key) => key.endsWith(':plugin.yaml') || key === 'plugin.yaml')
  const plugins: PluginEntry[] = []

  for (const key of manifestKeys) {
    const id = key.replace(/:plugin\.yaml$/, '')
    if (!id) throw new Error(`Invalid Plugin manifest asset key: ${key}`)
    const text = (await storage.getItem(key)) as string
    if (!text) throw new Error(`${id}: missing plugin.yaml`)
    plugins.push({
      ...parsePluginManifest(text, id),
      bundled_skills: await readBundledSkills(id),
    })
  }

  return plugins
}

async function scanPlugins(): Promise<PluginEntry[]> {
  const explicit = await scanExplicitPlugins()
  return explicit.sort((a, b) => a.name.localeCompare(b.name))
}

async function getCache(): Promise<PluginEntry[]> {
  if (!cache) {
    cache = await scanPlugins()
  }
  return cache
}

export async function getAllPlugins(options?: {
  q?: string
  tag?: string
  page?: number
  limit?: number
}) {
  const all = await getCache()
  let filtered = all

  if (options?.tag) {
    const tag = options.tag.toLowerCase()
    filtered = filtered.filter((plugin) => plugin.tags?.some((item) => item.toLowerCase() === tag))
  }

  if (options?.q) {
    const q = options.q.toLowerCase()
    filtered = filtered.filter(
      (plugin) =>
        plugin.name.toLowerCase().includes(q) ||
        plugin.description.toLowerCase().includes(q) ||
        plugin.tags?.some((tag) => tag.toLowerCase().includes(q)) ||
        plugin.capabilities?.some((capability) => capability.toLowerCase().includes(q)),
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

export async function getPluginById(id: string): Promise<PluginEntry | undefined> {
  const all = await getCache()
  return all.find((plugin) => plugin.id === id)
}

export async function getAllPluginTags(): Promise<string[]> {
  const all = await getCache()
  const tags = new Set<string>()
  for (const plugin of all) {
    if (plugin.tags) {
      for (const tag of plugin.tags) tags.add(tag)
    }
  }
  return [...tags].sort()
}

export async function getPluginFiles(id: string): Promise<Record<string, Uint8Array>> {
  const plugin = await getPluginById(id)
  if (!plugin) return {}

  const encoder = new TextEncoder()
  const { bundled_skills: _bundledSkills, ...manifest } = plugin
  const files: Record<string, Uint8Array> = {
    'plugin.yaml': encoder.encode(stringifyYaml(manifest)),
  }

  const storage = useStorage('assets/plugins')
  const allKeys = await storage.getKeys()
  const pluginPrefix = `${id}:`
  for (const key of allKeys) {
    if (!key.startsWith(pluginPrefix)) continue
    const pluginRelativeKey = key.substring(pluginPrefix.length)
    if (
      pluginRelativeKey !== 'hooks.json' &&
      !bundledPluginAssetPrefixes.some((prefix) => pluginRelativeKey.startsWith(prefix))
    ) {
      continue
    }
    const relativePath = pluginRelativeKey.replaceAll(':', '/')
    const raw = await storage.getItemRaw(key)
    if (raw instanceof Uint8Array) {
      files[relativePath] = raw
    } else if (raw instanceof ArrayBuffer) {
      files[relativePath] = new Uint8Array(raw)
    } else if (typeof raw === 'string') {
      files[relativePath] = encoder.encode(raw)
    } else if (raw != null) {
      files[relativePath] = encoder.encode(String(raw))
    }
  }

  return files
}
