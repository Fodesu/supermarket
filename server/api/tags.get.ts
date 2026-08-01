import { defineHandler } from 'nitro'
import { getAllPluginTags } from '#server/services/plugin'
import { getRegistrySkillTags } from '#server/services/skill-registry'

export default defineHandler(async (event) => {
  const [pluginTags, registrySkillTags] = await Promise.all([
    getAllPluginTags(event), getRegistrySkillTags(event),
  ])
  const merged = new Set([...pluginTags, ...registrySkillTags])
  return { tags: [...merged].sort() }
})
