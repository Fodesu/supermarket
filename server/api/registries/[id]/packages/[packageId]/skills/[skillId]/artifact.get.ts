import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'h3'
import { requireSkillRegistryID } from '#server/services/skill-registry-query'
import { getCatalogSkill } from '#server/services/skill-registry'

export default defineHandler(async (event) => {
  const registryID = requireSkillRegistryID(getRouterParam(event, 'id')!, 'registry ID')
  const packageID = requireSkillRegistryID(getRouterParam(event, 'packageId')!, 'package ID')
  const skillID = requireSkillRegistryID(getRouterParam(event, 'skillId')!, 'skill ID')
  const skill = await getCatalogSkill(event, registryID, packageID, skillID)
  if (!skill) throw new HTTPError(`Skill "${registryID}/${packageID}/${skillID}" not found`, { statusCode: 404 })
  return { ...skill.artifact, download_url: `/api/artifacts/${skill.artifact.digest}/download` }
})
