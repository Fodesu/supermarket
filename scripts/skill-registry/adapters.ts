import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import type {
  RegistryDiagnostic,
  SkillRegistryDefinition,
  SkillRuntimeRequirements,
} from '../../server/types/skill-registry'
import type { SkillAuthor } from '../../server/types/skill'
import { normalizeSkillCategory } from '../../server/utils/skill-catalog-search'
import { assertRegistryID, resolveSkillRuntimeRequirements, safeRelativePath } from '../../server/utils/skill-registry-definition'
import { readDirectoryFiles, resolveInside } from './files'

export interface SkillCandidate {
  package_id: string
  skill_id: string
  install_id: string
  name: string
  description: string
  author: SkillAuthor
  homepage?: string
  tags: string[]
  category: string
  category_name: string
  source_category?: string
  runtime_requirements: SkillRuntimeRequirements
  source_path: string
  files: Record<string, Uint8Array>
}

export interface SkillAdapterResult {
  skills: SkillCandidate[]
  diagnostics: RegistryDiagnostic[]
}

function uniqueStrings(...values: unknown[]) {
  const output = new Set<string>()
  for (const value of values) {
    if (!Array.isArray(value)) continue
    for (const item of value) {
      const text = String(item).trim()
      if (text) output.add(text)
    }
  }
  return [...output]
}

function normalizeAuthor(value: unknown, fallback?: SkillAuthor): SkillAuthor {
  if (typeof value === 'string') return { name: value, email: '' }
  if (!value || typeof value !== 'object') return fallback ?? { name: '', email: '' }
  const author = value as Record<string, unknown>
  return { name: String(author.name ?? fallback?.name ?? ''), email: String(author.email ?? fallback?.email ?? '') }
}

function parseSkill(files: Record<string, Uint8Array>, fallbackID: string) {
  const manifest = files['SKILL.md']
  if (!manifest) throw new Error(`Skill ${fallbackID} is missing SKILL.md`)
  const text = new TextDecoder().decode(manifest)
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!frontmatter) throw new Error(`Skill ${fallbackID} is missing YAML frontmatter`)
  const data = parseYaml(frontmatter[1]!)
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`Skill ${fallbackID} YAML frontmatter must be an object`)
  }
  return { data, metadata: data.metadata && typeof data.metadata === 'object' ? data.metadata : {} }
}

function hasComponent(value: unknown) {
  if (Array.isArray(value)) return value.length > 0
  if (value && typeof value === 'object') return Object.keys(value).length > 0
  return typeof value === 'string' ? value.trim().length > 0 : Boolean(value)
}

function installID(registryID: string, packageID: string, skillID: string) {
  return `${registryID}+${packageID}+${skillID}`
}

async function candidate(input: {
  definition: SkillRegistryDefinition
  packageID: string
  skillID: string
  sourcePath: string
  root: string
  packageManifest?: Record<string, any>
  sourceCategory?: string
}): Promise<SkillCandidate> {
  const { definition, packageID, skillID, sourcePath, root, packageManifest = {}, sourceCategory } = input
  const files = await readDirectoryFiles(root)
  const { data, metadata } = parseSkill(files, skillID)
  const packageAuthor = normalizeAuthor(packageManifest.author)
  const category = normalizeSkillCategory(
    String(metadata.category ?? data.category ?? sourceCategory ?? '').trim() || undefined,
    definition.taxonomy?.mappings,
  )
  return {
    package_id: packageID,
    skill_id: skillID,
    install_id: installID(definition.id, packageID, skillID),
    name: String(data.name ?? skillID),
    description: String(data.description ?? ''),
    author: normalizeAuthor(metadata.author, packageAuthor),
    homepage: metadata.homepage ? String(metadata.homepage) : packageManifest.homepage ? String(packageManifest.homepage) : undefined,
    tags: uniqueStrings(metadata.tags, data.tags, packageManifest.keywords),
    category: category.id,
    category_name: category.name,
    source_category: category.sourceName,
    runtime_requirements: resolveSkillRuntimeRequirements(
      definition, packageID, skillID, metadata.runtime_requirements ?? data.runtime_requirements ?? packageManifest.runtime_requirements,
    ),
    source_path: sourcePath,
    files,
  }
}

async function directorySkills(
  definition: SkillRegistryDefinition,
  sourceRoot: string,
  packageFilter?: string,
  skillFilter?: string,
): Promise<SkillAdapterResult> {
  const skills: SkillCandidate[] = []
  const entries = await readdir(sourceRoot, { withFileTypes: true })
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      await readFile(path.join(sourceRoot, entry.name, 'SKILL.md'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    const id = assertRegistryID(entry.name, 'skill ID')
    if (packageFilter && id !== packageFilter) continue
    if (skillFilter && id !== skillFilter) continue
    skills.push(await candidate({
      definition, packageID: id, skillID: id, sourcePath: id, root: resolveInside(sourceRoot, id),
    }))
  }
  if ((packageFilter || skillFilter) && skills.length === 0) {
    throw new Error(`${definition.id}: skill "${skillFilter ?? packageFilter}" not found`)
  }
  return { skills, diagnostics: [] }
}

interface MarketplaceEntry { name: string; category?: string; source: unknown }

function parseMarketplace(raw: unknown): MarketplaceEntry[] {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as any).plugins)) {
    throw new Error('Codex Marketplace must contain a plugins array')
  }
  const names = new Set<string>()
  return (raw as any).plugins.map((item: any, index: number) => {
    if (!item || typeof item !== 'object') throw new Error(`Marketplace package ${index} must be an object`)
    const name = assertRegistryID(String(item.name ?? '').trim(), `package ${index} ID`)
    if (names.has(name)) throw new Error(`Marketplace contains duplicate package ID: ${name}`)
    names.add(name)
    return { name, category: item.category ? String(item.category) : undefined, source: item.source }
  })
}

function localPackagePath(source: unknown) {
  let value: string | undefined
  if (typeof source === 'string') value = source
  else if (source && typeof source === 'object') {
    const data = source as Record<string, unknown>
    if (data.source === 'local' && typeof data.path === 'string') value = data.path
  }
  return value ? safeRelativePath(value, 'Marketplace package path') : undefined
}

function codexSkillPaths(value: unknown) {
  const values = typeof value === 'string' ? [value] : Array.isArray(value) ? value : []
  if (values.length === 0 || values.some((item) => typeof item !== 'string')) {
    throw new Error('Codex package skills must be a path or an array of paths')
  }
  return [...new Set(values.map((item) => safeRelativePath(item as string, 'Codex skill path')))]
}

async function discoverSkillRoots(packageRoot: string, declaredPath: string) {
  const declaredRoot = resolveInside(packageRoot, declaredPath)
  try {
    await readFile(path.join(declaredRoot, 'SKILL.md'))
    return [{ id: assertRegistryID(path.posix.basename(declaredPath), 'skill ID'), root: declaredRoot, relativePath: declaredPath }]
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const entries = await readdir(declaredRoot, { withFileTypes: true })
  const roots: Array<{ id: string; root: string; relativePath: string }> = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue
    const root = resolveInside(declaredRoot, entry.name)
    try {
      await readFile(path.join(root, 'SKILL.md'))
      roots.push({ id: assertRegistryID(entry.name, 'skill ID'), root, relativePath: `${declaredPath}/${entry.name}` })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  if (!roots.length) throw new Error(`Codex skill path "${declaredPath}" contains no SKILL.md`)
  return roots
}

async function codexMarketplaceSkills(
  definition: SkillRegistryDefinition,
  sourceRoot: string,
  ensurePaths: (paths: string[]) => Promise<void>,
  packageFilter?: string,
  skillFilter?: string,
): Promise<SkillAdapterResult> {
  const entries = parseMarketplace(JSON.parse(await readFile(resolveInside(sourceRoot, definition.catalog_path!), 'utf8')))
    .filter((entry) => !packageFilter || entry.name === packageFilter)
  if (packageFilter && !entries.length) throw new Error(`${definition.id}: package "${packageFilter}" not found`)
  const packages = entries.map((entry) => {
    const packagePath = localPackagePath(entry.source)
    if (!packagePath) throw new Error(`${definition.id}: package "${entry.name}" uses an unsupported source`)
    return { entry, packagePath }
  })
  await ensurePaths(packages.map(({ packagePath }) => `${packagePath}/.codex-plugin/plugin.json`))

  const prepared = []
  const diagnostics: RegistryDiagnostic[] = []
  for (const item of packages) {
    const manifest = JSON.parse(await readFile(resolveInside(sourceRoot, `${item.packagePath}/.codex-plugin/plugin.json`), 'utf8')) as Record<string, any>
    if (String(manifest.name ?? '') !== item.entry.name) {
      throw new Error(`${definition.id}: package "${item.entry.name}" manifest name does not match`)
    }
    const unsupported = ['apps', 'mcpServers', 'hooks'].filter((key) => hasComponent(manifest[key]))
    if (unsupported.length) {
      diagnostics.push({
        package_id: item.entry.name, code: 'source_requires_runtime_components',
        message: `Skipped package because it declares: ${unsupported.join(', ')}`,
      })
      continue
    }
    if (!hasComponent(manifest.skills)) {
      diagnostics.push({ package_id: item.entry.name, code: 'no_skills', message: 'Skipped package because it declares no skills' })
      continue
    }
    const skillPaths = codexSkillPaths(manifest.skills)
    prepared.push({ ...item, manifest, skillPaths })
  }
  await ensurePaths(prepared.flatMap((item) => item.skillPaths.map((skillPath) => `${item.packagePath}/${skillPath}`)))

  const skills: SkillCandidate[] = []
  for (const item of prepared) {
    const packageRoot = resolveInside(sourceRoot, item.packagePath)
    const seen = new Set<string>()
    for (const skillPath of item.skillPaths) {
      for (const root of await discoverSkillRoots(packageRoot, skillPath)) {
        if (seen.has(root.id)) throw new Error(`${definition.id}/${item.entry.name}: duplicate skill ID ${root.id}`)
        seen.add(root.id)
        if (skillFilter && root.id !== skillFilter) continue
        skills.push(await candidate({
          definition, packageID: item.entry.name, skillID: root.id,
          sourcePath: `${item.packagePath}/${root.relativePath}`, root: root.root,
          packageManifest: item.manifest, sourceCategory: item.entry.category,
        }))
      }
    }
  }
  if (skillFilter && !skills.length) throw new Error(`${definition.id}/${packageFilter}: skill "${skillFilter}" not found`)
  return { skills, diagnostics }
}

export function buildSkillCandidates(input: {
  definition: SkillRegistryDefinition
  sourceRoot: string
  ensurePaths?: (paths: string[]) => Promise<void>
  packageFilter?: string
  skillFilter?: string
}) {
  const { definition, sourceRoot, packageFilter, skillFilter, ensurePaths = async () => {} } = input
  if (skillFilter && !packageFilter) throw new Error('--skill requires --package')
  if (definition.adapter === 'skill_directory') {
    return directorySkills(definition, sourceRoot, packageFilter, skillFilter)
  }
  if (definition.adapter === 'codex_marketplace_skills') {
    return codexMarketplaceSkills(definition, sourceRoot, ensurePaths, packageFilter, skillFilter)
  }
  throw new Error(`${definition.id}: unsupported adapter ${definition.adapter}`)
}
