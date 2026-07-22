import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'h3'
import { getCatalogSkill } from '../../../../../../../utils/skill-registry-loader'
import { requireSkillRegistryID } from '../../../../../../../utils/skill-registry-query'

export default defineHandler(async (event) => {
  const registryID = requireSkillRegistryID(getRouterParam(event, 'id')!, 'registry ID')
  const packageID = requireSkillRegistryID(getRouterParam(event, 'packageId')!, 'package ID')
  const skillID = requireSkillRegistryID(getRouterParam(event, 'skillId')!, 'skill ID')
  const skill = await getCatalogSkill(event, registryID, packageID, skillID)
  if (!skill) throw new HTTPError(`Skill "${registryID}/${packageID}/${skillID}" not found`, { statusCode: 404 })
  return { ...skill.artifact, download_url: `/api/artifacts/${skill.artifact.digest}/download` }
})
