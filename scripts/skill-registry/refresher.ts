import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import type {
  CatalogSkill,
  RegistryDiagnostic,
  SkillArtifactDescriptor,
  SkillRegistryCatalog,
  SkillRegistryDefinition,
} from '../../server/types/skill-registry'
import { parseSkillRegistryDefinition } from '../../server/utils/skill-registry-definition'
import type { SkillRegistryStore } from '../../server/utils/skill-registry-store'
import { sha256 } from '../../server/utils/skill-registry-store'
import { buildSkillCandidates } from './adapters'
import { packageSkill } from './files'
import { materializeSkillRegistrySource } from './source'

export async function loadSkillRegistryDefinitions(projectRoot: string) {
  const root = path.join(projectRoot, 'registries')
  const definitions: SkillRegistryDefinition[] = []
  const ids = new Set<string>()
  for await (const relativePath of new Bun.Glob('*/registry.yaml').scan({ cwd: root })) {
    const definition = parseSkillRegistryDefinition(parseYaml(await readFile(path.join(root, relativePath), 'utf8')))
    if (ids.has(definition.id)) throw new Error(`Duplicate registry ID: ${definition.id}`)
    if (path.dirname(relativePath) !== definition.id) throw new Error(`${relativePath}: directory must match Registry ID`)
    ids.add(definition.id)
    definitions.push(definition)
  }
  return definitions.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
}

function stableCatalogContent(definition: SkillRegistryDefinition, skills: CatalogSkill[], diagnostics: RegistryDiagnostic[]) {
  return {
    registry: definition,
    skills: skills.map((skill) => ({
      ...skill,
      artifact: { ...skill.artifact, created_at: undefined },
    })),
    diagnostics,
  }
}

export class SkillRegistryRefresher {
  constructor(private readonly store: SkillRegistryStore, private readonly projectRoot: string) {}

  async refresh(
    definition: SkillRegistryDefinition,
    options: { package?: string; skill?: string; force?: boolean } = {},
  ) {
    if (options.skill && !options.package) throw new Error('--skill requires --package')
    const attemptedAt = new Date().toISOString()
    await this.store.putDefinition(definition)
    const current = await this.store.getCatalog(definition.id)
    if (!definition.enabled) {
      await this.store.putStatus({ registry_id: definition.id, state: 'disabled', current_revision: current?.revision, last_attempt_at: attemptedAt })
      return { registry: definition.id, skipped: 'disabled' }
    }
    await this.store.putStatus({
      registry_id: definition.id, state: 'refreshing', current_revision: current?.revision,
      last_attempt_at: attemptedAt, last_success_at: current?.synced_at,
    })

    let source
    try {
      source = await materializeSkillRegistrySource(definition, this.projectRoot)
      const result = await buildSkillCandidates({
        definition: source.definition, sourceRoot: source.root, ensurePaths: source.ensurePaths,
        packageFilter: options.package, skillFilter: options.skill,
      })
      const createdAt = new Date().toISOString()
      const refreshed: CatalogSkill[] = []
      for (const candidate of result.skills) {
        const packaged = await packageSkill(candidate.files, candidate.install_id)
        const existingCreatedAt = current?.skills.find((skill) =>
          skill.registry_id === definition.id
          && skill.package_id === candidate.package_id
          && skill.skill_id === candidate.skill_id
          && skill.artifact.digest === packaged.digest,
        )?.artifact.created_at
        const descriptor: SkillArtifactDescriptor = {
          registry_id: definition.id, package_id: candidate.package_id, skill_id: candidate.skill_id,
          source_revision: source.revision, format: 'memoh_skill_v1', digest: packaged.digest,
          size: packaged.bytes.length, filename: `${candidate.install_id}.tar.gz`,
          content_type: 'application/gzip', created_at: existingCreatedAt ?? createdAt,
        }
        await this.store.putArtifact(descriptor, packaged.bytes)
        refreshed.push({
          schema_version: '1', registry_id: definition.id, registry_priority: definition.priority,
          package_id: candidate.package_id, skill_id: candidate.skill_id, install_id: candidate.install_id,
          name: candidate.name, description: candidate.description, author: candidate.author,
          homepage: candidate.homepage, tags: candidate.tags,
          category: candidate.category, category_name: candidate.category_name, source_category: candidate.source_category,
          runtime_requirements: candidate.runtime_requirements,
          source: {
            type: definition.source.type, revision: source.revision, path: candidate.source_path,
            repository: definition.source.type === 'git' ? definition.source.url : undefined,
          },
          files: Object.keys(candidate.files).sort(), artifact: descriptor,
        })
      }

      let skills: CatalogSkill[]
      let diagnostics: RegistryDiagnostic[]
      if (!options.package) {
        skills = refreshed
        diagnostics = result.diagnostics
      } else {
        const retained = (current?.skills ?? []).filter((skill) => {
          if (skill.package_id !== options.package) return true
          return options.skill ? skill.skill_id !== options.skill : false
        })
        skills = [...retained, ...refreshed]
        diagnostics = [
          ...(current?.diagnostics ?? []).filter((item) => item.package_id !== options.package),
          ...result.diagnostics,
        ]
      }
      skills.sort((a, b) => a.name.localeCompare(b.name) || a.package_id.localeCompare(b.package_id) || a.skill_id.localeCompare(b.skill_id))
      diagnostics.sort((a, b) => (a.package_id ?? '').localeCompare(b.package_id ?? '') || a.code.localeCompare(b.code))
      const contentRevision = await sha256(JSON.stringify(stableCatalogContent(source.definition, skills, diagnostics)))
      const unchanged = current?.content_revision === contentRevision
      if (!options.force && unchanged) {
        await this.store.putStatus({
          registry_id: definition.id, state: skills.length ? 'ready' : 'empty', current_revision: current.revision,
          last_attempt_at: attemptedAt, last_success_at: current.synced_at,
        })
        return { registry: definition.id, revision: current.revision, skills: skills.length, skipped: 'unchanged' }
      }
      const revision = options.force
        ? await sha256(`${contentRevision}\nforced:${crypto.randomUUID()}`)
        : contentRevision
      const catalog: SkillRegistryCatalog = {
        schema_version: '1', registry: source.definition, revision, content_revision: contentRevision,
        source_revision: source.revision, synced_at: createdAt, skills, diagnostics,
      }
      await this.store.publishCatalog(catalog)
      await this.store.putStatus({
        registry_id: definition.id, state: skills.length ? 'ready' : 'empty', current_revision: revision,
        last_attempt_at: attemptedAt, last_success_at: createdAt,
      })
      return { registry: definition.id, revision, skills: skills.length, diagnostics: diagnostics.length }
    } catch (error) {
      await this.store.putStatus({
        registry_id: definition.id, state: current ? 'stale' : 'empty', current_revision: current?.revision,
        last_attempt_at: attemptedAt, last_success_at: current?.synced_at,
        last_error: error instanceof Error ? error.message : String(error),
      })
      throw error
    } finally {
      await source?.cleanup()
    }
  }
}
