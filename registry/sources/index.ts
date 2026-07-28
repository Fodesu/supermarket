import type { SkillRegistryDefinition } from '../types'
import { materializeGitSource } from './git'
import { materializeLocalSource } from './local'
import type { MaterializedSkillRegistrySource } from './types'

export type { MaterializedSkillRegistrySource } from './types'

export function materializeSkillRegistrySource(
  definition: SkillRegistryDefinition,
  projectRoot: string,
): Promise<MaterializedSkillRegistrySource> {
  if (definition.source.type === 'local') return materializeLocalSource(definition, projectRoot)
  if (definition.source.type === 'git') return materializeGitSource(definition)
  return Promise.reject(new Error(`${definition.id}: unsupported source type`))
}
