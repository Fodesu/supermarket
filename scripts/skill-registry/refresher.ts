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

// A snapshot revision identifies its reader-visible content. Upstream commits
// that do not change a published Skill therefore keep the same revision.
function stableCatalogContent(definition: SkillRegistryDefinition, skills: CatalogSkill[], diagnostics: RegistryDiagnostic[]) {
  return {
    registry: definition,
    skills: skills.map((skill) => ({
      ...skill,
      source: { ...skill.source, revision: undefined },
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

export type SkillRegistryRefreshProgress =
  | { type: 'source'; registry: string }
  | { type: 'source_ready'; registry: string; revision: string }
  | { type: 'scanned'; registry: string; skills: number; diagnostics: number }
  | { type: 'skill'; registry: string; index: number; total: number; package_id: string; skill_id: string; uploaded: boolean }
  | { type: 'publishing'; registry: string; revision: string }

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
    private readonly assertWriterActive: () => void = () => {},
    private readonly onProgress: (progress: SkillRegistryRefreshProgress) => void = () => {},
  ) {}

  async refresh(
    definition: SkillRegistryDefinition,
    options: { package?: string; skill?: string } = {},
  ) {
    this.assertWriterActive()
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
    options: { package?: string; skill?: string },
  ) {
    if (options.skill && !options.package) throw new Error('--skill requires --package')
    const attemptedAt = new Date().toISOString()
    const previousState = await this.store.getState(definition.id)
    const previousStatus = previousState?.status ?? null
    const current = previousState?.current_snapshot
      ? await this.store.getSnapshot(definition.id, previousState.current_snapshot)
      : null
    if (previousState?.current_snapshot && !current) {
      throw new Error(`Current Registry snapshot is missing: ${definition.id}/${previousState.current_snapshot}`)
    }
    const putState = async (
      status: SkillRegistryStatus,
      currentSnapshot = current?.revision,
      stateDefinition = previousState?.definition ?? definition,
    ) => {
      await this.store.putState({
        schema_version: '1', definition: stateDefinition, current_snapshot: currentSnapshot, status,
      })
    }
    if (options.package && current && !sameDefinition(current.registry, definition)) {
      throw new Error(`${definition.id}: scoped refresh requires an unchanged Registry definition; run a full refresh`)
    }
    const lastSuccessAt = previousStatus?.last_success_at ?? current?.synced_at

    if (!definition.enabled) {
      this.assertWriterActive()
      await putState({
        state: 'disabled', last_attempt_at: attemptedAt, last_success_at: lastSuccessAt,
      }, current?.revision, definition)
      return { registry: definition.id, skipped: 'disabled' }
    }
    this.assertWriterActive()
    await putState({
      state: 'refreshing', last_attempt_at: attemptedAt, last_success_at: lastSuccessAt,
    }, current?.revision)

    let source
    let completed: CompletedRefresh | undefined
    try {
      if (options.package && !current) {
        throw new Error(`${definition.id}: scoped refresh requires an existing Catalog`)
      }
      this.onProgress({ type: 'source', registry: definition.id })
      source = await materializeSkillRegistrySource(definition, this.projectRoot)
      this.onProgress({ type: 'source_ready', registry: definition.id, revision: source.revision })
      this.assertWriterActive()
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
      this.onProgress({
        type: 'scanned', registry: definition.id,
        skills: result.skills.length, diagnostics: result.diagnostics.length,
      })
      const refreshed: CatalogSkill[] = []
      const storedImages = new Set<string>()
      for (const candidate of result.skills) {
        this.assertWriterActive()
        const packaged = await packageSkill(candidate.files)
        const descriptor: SkillArtifactDescriptor = {
          format: 'memoh_skill_v1', digest: packaged.digest,
          size: packaged.bytes.length, content_type: 'application/gzip',
        }
        this.assertWriterActive()
        const artifactUploaded = (await this.store.putArtifact(descriptor, packaged.bytes))?.stored === true
        let imagesUploaded = false
        for (const image of candidate.icon_assets ?? []) {
          if (storedImages.has(image.descriptor.digest)) continue
          this.assertWriterActive()
          imagesUploaded = ((await this.store.putImage(image.descriptor, image.bytes))?.stored === true) || imagesUploaded
          storedImages.add(image.descriptor.digest)
        }
        this.onProgress({
          type: 'skill', registry: definition.id,
          index: refreshed.length + 1, total: result.skills.length,
          package_id: candidate.package_id, skill_id: candidate.skill_id,
          uploaded: artifactUploaded || imagesUploaded,
        })
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
          files: Object.keys(candidate.files).sort(), icon: candidate.icon, artifact: descriptor,
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
      const revision = await sha256(JSON.stringify(stableCatalogContent(source.definition, skills, diagnostics)))
      const unchanged = current?.revision === revision
      const succeededAt = new Date().toISOString()
      if (unchanged) {
        completed = {
          revision: current.revision, state: skills.length ? 'ready' : 'empty', succeededAt,
          result: { registry: definition.id, revision: current.revision, skills: skills.length, skipped: 'unchanged' },
        }
        this.assertWriterActive()
        await putState({
          state: completed.state, last_attempt_at: attemptedAt, last_success_at: succeededAt,
        }, current.revision, definition)
        return completed.result
      }
      const catalog: SkillRegistryCatalog = {
        schema_version: '1', registry: source.definition, revision,
        source_revision: source.revision, synced_at: succeededAt, skills, diagnostics,
      }
      completed = {
        revision, state: skills.length ? 'ready' : 'empty', succeededAt,
        result: { registry: definition.id, revision, skills: skills.length, diagnostics: diagnostics.length },
      }
      this.onProgress({ type: 'publishing', registry: definition.id, revision })
      this.assertWriterActive()
      await this.store.publishSnapshot(catalog, {
        schema_version: '1', definition, current_snapshot: revision,
        status: {
          state: completed.state, last_attempt_at: attemptedAt, last_success_at: succeededAt,
        },
      }, this.assertWriterActive)
      return completed.result
    } catch (error) {
      if (error instanceof IndeterminateRemoteMutationError) throw error
      this.assertWriterActive()
      if (completed) {
        const live = await this.store.getSnapshot(definition.id, completed.revision)
        if (live?.revision === completed.revision) {
          this.assertWriterActive()
          await putState({
            state: completed.state, last_attempt_at: attemptedAt, last_success_at: completed.succeededAt,
          }, completed.revision, definition)
          return completed.result
        }
      }
      const liveState = await this.store.getState(definition.id).catch(() => previousState)
      const live = liveState?.current_snapshot
        ? await this.store.getSnapshot(definition.id, liveState.current_snapshot).catch(() => current)
        : null
      this.assertWriterActive()
      await putState({
        state: live ? 'stale' : 'empty',
        last_attempt_at: attemptedAt, last_success_at: lastSuccessAt,
        last_error: error instanceof Error ? error.message : String(error),
      }, live?.revision)
      throw error
    } finally {
      await source?.cleanup()
    }
  }
}
