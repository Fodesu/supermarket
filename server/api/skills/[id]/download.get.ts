import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam, setResponseHeader } from 'h3'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { getSkillById, getSkillsDir } from '../../../utils/skill-loader'

export default defineHandler(async (event) => {
  const id = getRouterParam(event, 'id')!

  const skill = await getSkillById(id)
  if (!skill) {
    throw new HTTPError(`Skill "${id}" not found`, { statusCode: 404 })
  }

  const skillDir = join(getSkillsDir(), id)
  const s = await stat(skillDir)
  if (!s.isDirectory()) {
    throw new HTTPError(`Skill directory "${id}" not found`, { statusCode: 404 })
  }

  const tarBuffer = execSync(`tar -czf - -C "${getSkillsDir()}" "${id}"`)

  setResponseHeader(event, 'content-type', 'application/gzip')
  setResponseHeader(event, 'content-disposition', `attachment; filename="${id}.tar.gz"`)
  return tarBuffer
})
