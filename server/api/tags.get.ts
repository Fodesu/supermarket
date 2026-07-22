import { defineHandler } from 'nitro'
import { getAllPluginTags } from '../utils/plugin-loader'
import { getAllSkillTags } from '../utils/skill-loader'
import { getRegistrySkillTags } from '../utils/skill-registry-loader'

export default defineHandler(async (event) => {
  const [pluginTags, skillTags, registrySkillTags] = await Promise.all([
    getAllPluginTags(), getAllSkillTags(), getRegistrySkillTags(event),
  ])
  const merged = new Set([...pluginTags, ...skillTags, ...registrySkillTags])
  return { tags: [...merged].sort() }
})
