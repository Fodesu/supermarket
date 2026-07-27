import { defineHandler } from 'nitro'
import { getAllPluginTags } from '../utils/plugin-loader'
import { getRegistrySkillTags } from '../utils/skill-registry-loader'

export default defineHandler(async (event) => {
  const [pluginTags, registrySkillTags] = await Promise.all([
    getAllPluginTags(), getRegistrySkillTags(event),
  ])
  const merged = new Set([...pluginTags, ...registrySkillTags])
  return { tags: [...merged].sort() }
})
