import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import type {
  CatalogSkill,
  RegistryDiagnostic,
  SkillArtifactDescriptor,
  SkillRegistryCatalog,
  SkillRegistryDefinition,
  SkillRegistryStatus,
} from '../../server/types/skill-registry'
import { parseSkillRegistryDefinition } from '../../server/utils/skill-registry-definition'
import type { SkillRegistryStore } from '../../server/utils/skill-registry-store'
import { IndeterminateRemoteMutationError, sha256 } from '../../server/utils/skill-registry-store'
import { buildSkillCandidates } from './adapters'
import { packageSkill } from './files'
import { materializeSkillRegistrySource } from './source'

export interface SkillRegistryDefinitionFailure {
  registry: string
  path: string
  error: unknown
}

export async function loadSkillRegistryDefinitionResults(projectRoot: string) {
  const root = path.join(projectRoot, 'registries')
  const definitions: SkillRegistryDefinition[] = []
  const failures: SkillRegistryDefinitionFailure[] = []
  const ids = new Set<string>()
  for await (const relativePath of new Bun.Glob('*/registry.yaml').scan({ cwd: root })) {
    try {
      const definition = parseSkillRegistryDefinition(parseYaml(await readFile(path.join(root, relativePath), 'utf8')))
      if (ids.has(definition.id)) throw new Error(`Duplicate registry ID: ${definition.id}`)
      if (path.dirname(relativePath) !== definition.id) throw new Error(`${relativePath}: directory must match Registry ID`)
      ids.add(definition.id)
      definitions.push(definition)
    } catch (error) {
      failures.push({ registry: path.dirname(relativePath), path: relativePath, error })
    }
  }
  definitions.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
  failures.sort((a, b) => a.path.localeCompare(b.path))
  return { definitions, failures }
}

export async function loadSkillRegistryDefinitions(projectRoot: string) {
  const result = await loadSkillRegistryDefinitionResults(projectRoot)
  if (result.failures.length) {
    throw new AggregateError(
      result.failures.map((failure) => failure.error),
      result.failures.map((failure) => `${failure.path}: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}`).join('\n'),
    )
  }
  return result.definitions
}

export function isSkillRegistryRefreshDue(
  definition: SkillRegistryDefinition,
  status: SkillRegistryStatus | null,
  now = Date.now(),
) {
  if (!status?.last_success_at) return true
  const lastSuccess = Date.parse(status.last_success_at)
  return !Number.isFinite(lastSuccess) || now >= lastSuccess + definition.refresh_interval_seconds * 1000
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

function sameDefinition(left: SkillRegistryDefinition, right: SkillRegistryDefinition) {
  return JSON.stringify(left) === JSON.stringify(right)
}

export interface SkillRegistryRefreshResult {
  registry: string
  revision?: string
  skills?: number
  diagnostics?: number
  skipped?: string
}

interface CompletedRefresh {
  revision: string
  state: SkillRegistryStatus['state']
  succeededAt: string
  result: SkillRegistryRefreshResult
}

export class SkillRegistryRefresher {
  private readonly activeRegistries = new Set<string>()

  constructor(
    private readonly store: SkillRegistryStore,
    private readonly projectRoot: string,
    private readonly assertWriterLease: () => void = () => {},
  ) {}

  async refresh(
    definition: SkillRegistryDefinition,
    options: { package?: string; skill?: string; force?: boolean } = {},
  ) {
    this.assertWriterLease()
    if (this.activeRegistries.has(definition.id)) {
      throw new Error(`${definition.id}: another refresh is already running in this Refresher`)
    }
    this.activeRegistries.add(definition.id)
    try {
      return await this.refreshRegistry(definition, options)
    } finally {
      this.activeRegistries.delete(definition.id)
    }
  }

  private async refreshRegistry(
    definition: SkillRegistryDefinition,
    options: { package?: string; skill?: string; force?: boolean },
  ) {
    if (options.skill && !options.package) throw new Error('--skill requires --package')
    const attemptedAt = new Date().toISOString()
    const [current, previousStatus] = await Promise.all([
      this.store.getCatalog(definition.id),
      this.store.getStatus(definition.id),
    ])
    if (options.package && current && !sameDefinition(current.registry, definition)) {
      throw new Error(`${definition.id}: scoped refresh requires an unchanged Registry definition; run a full refresh`)
    }
    const lastSuccessAt = previousStatus?.last_success_at ?? current?.synced_at
    if (!definition.enabled) {
      this.assertWriterLease()
      await this.store.putDefinition(definition)
      this.assertWriterLease()
      await this.store.putStatus({
        registry_id: definition.id, state: 'disabled', current_revision: current?.revision,
        last_attempt_at: attemptedAt, last_success_at: lastSuccessAt,
      })
      return { registry: definition.id, skipped: 'disabled' }
    }
    this.assertWriterLease()
    await this.store.putStatus({
      registry_id: definition.id, state: 'refreshing', current_revision: current?.revision,
      last_attempt_at: attemptedAt, last_success_at: lastSuccessAt,
    })

    let source
    let completed: CompletedRefresh | undefined
    try {
      if (options.package && !current) {
        throw new Error(`${definition.id}: scoped refresh requires an existing Catalog`)
      }
      source = await materializeSkillRegistrySource(definition, this.projectRoot)
      this.assertWriterLease()
      const scopeExists = options.package ? Boolean(options.skill
        ? current?.skills.some((skill) => skill.package_id === options.package && skill.skill_id === options.skill)
        : current?.skills.some((skill) => skill.package_id === options.package)
          || current?.diagnostics.some((item) => item.package_id === options.package)) : false
      const result = await buildSkillCandidates({
        definition: source.definition, sourceRoot: source.root, ensurePaths: source.ensurePaths,
        packageFilter: options.package, skillFilter: options.skill,
        allowMissingScope: scopeExists,
      })
      if (options.skill && result.diagnostics.some((item) => item.package_id === options.package)) {
        throw new Error(`${definition.id}/${options.package}: package compatibility changed; refresh the whole package`)
      }
      const createdAt = new Date().toISOString()
      const refreshed: CatalogSkill[] = []
      for (const candidate of result.skills) {
        this.assertWriterLease()
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
        this.assertWriterLease()
        await this.store.putArtifact(descriptor, packaged.bytes)
        refreshed.push({
          schema_version: '1', registry_id: definition.id, registry_priority: definition.priority,
          package_id: candidate.package_id, skill_id: candidate.skill_id, install_id: candidate.install_id,
          name: candidate.name, description: candidate.description, author: candidate.author,
          homepage: candidate.homepage, tags: candidate.tags,
          category: candidate.category, category_name: candidate.category_name, source_category: candidate.source_category,
          runtime_requirements: candidate.runtime_requirements,
          source: {
            type: definition.source.type, revision: source.revision,
            path: [definition.source.path, candidate.source_path].filter(Boolean).join('/'),
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
      const succeededAt = new Date().toISOString()
      if (!options.force && unchanged) {
        completed = {
          revision: current.revision, state: skills.length ? 'ready' : 'empty', succeededAt,
          result: { registry: definition.id, revision: current.revision, skills: skills.length, skipped: 'unchanged' },
        }
        this.assertWriterLease()
        await this.store.putDefinition(definition)
        this.assertWriterLease()
        await this.store.putStatus({
          registry_id: definition.id, state: completed.state, current_revision: current.revision,
          last_attempt_at: attemptedAt, last_success_at: succeededAt,
        })
        return completed.result
      }
      const revision = options.force
        ? await sha256(`${contentRevision}\nforced:${crypto.randomUUID()}`)
        : contentRevision
      const catalog: SkillRegistryCatalog = {
        schema_version: '1', registry: source.definition, revision, content_revision: contentRevision,
        source_revision: source.revision, synced_at: succeededAt, skills, diagnostics,
      }
      completed = {
        revision, state: skills.length ? 'ready' : 'empty', succeededAt,
        result: { registry: definition.id, revision, skills: skills.length, diagnostics: diagnostics.length },
      }
      this.assertWriterLease()
      await this.store.publishCatalog(catalog, this.assertWriterLease)
      this.assertWriterLease()
      await this.store.putDefinition(definition)
      this.assertWriterLease()
      await this.store.putStatus({
        registry_id: definition.id, state: completed.state, current_revision: revision,
        last_attempt_at: attemptedAt, last_success_at: succeededAt,
      })
      return completed.result
    } catch (error) {
      if (error instanceof IndeterminateRemoteMutationError) throw error
      this.assertWriterLease()
      if (completed) {
        const live = await this.store.getCatalog(definition.id)
        if (live?.revision === completed.revision) {
          this.assertWriterLease()
          await this.store.putDefinition(definition)
          this.assertWriterLease()
          await this.store.putStatus({
            registry_id: definition.id, state: completed.state, current_revision: completed.revision,
            last_attempt_at: attemptedAt, last_success_at: completed.succeededAt,
          })
          return completed.result
        }
      }
      const live = await this.store.getCatalog(definition.id).catch(() => current)
      this.assertWriterLease()
      await this.store.putStatus({
        registry_id: definition.id, state: live ? 'stale' : 'empty', current_revision: live?.revision,
        last_attempt_at: attemptedAt, last_success_at: lastSuccessAt,
        last_error: error instanceof Error ? error.message : String(error),
      })
      throw error
    } finally {
      await source?.cleanup()
    }
  }
}
