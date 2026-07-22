import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'h3'
import { getCatalogSkill } from '../../../../../../../utils/skill-registry-loader'

export default defineHandler(async (event) => {
  const registryID = getRouterParam(event, 'id')!
  const packageID = getRouterParam(event, 'packageId')!
  const skillID = getRouterParam(event, 'skillId')!
  const skill = await getCatalogSkill(event, registryID, packageID, skillID)
  if (!skill) throw new HTTPError(`Skill "${registryID}/${packageID}/${skillID}" not found`, { statusCode: 404 })
  return { ...skill.artifact, download_url: `/api/artifacts/${skill.artifact.digest}/download` }
})
