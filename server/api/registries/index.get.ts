import { defineHandler } from 'nitro'
import { getSkillRegistrySummaries } from '../../utils/skill-registry-loader'

export default defineHandler(async (event) => ({ data: await getSkillRegistrySummaries(event) }))
