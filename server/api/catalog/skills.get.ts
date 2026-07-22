import { defineHandler } from 'nitro'
import { getQuery } from 'h3'
import { getCatalogSkills } from '../../utils/skill-registry-loader'
import { parseSkillRegistryQuery } from '../../utils/skill-registry-query'

export default defineHandler(async (event) => getCatalogSkills(event, parseSkillRegistryQuery(getQuery(event))))
