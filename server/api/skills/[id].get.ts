import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'h3'
import { getSkillById } from '../../utils/skill-loader'

export default defineHandler(async (event) => {
  const id = getRouterParam(event, 'id')!

  const skill = await getSkillById(id)
  if (!skill) {
    throw new HTTPError(`Skill "${id}" not found`, { statusCode: 404 })
  }

  return skill
})
