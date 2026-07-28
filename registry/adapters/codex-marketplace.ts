import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import type {
  RegistryDiagnostic,
  SkillIcon,
  SkillImageAsset,
  SkillImageContentType,
} from '../types'
import { MAX_SKILL_IMAGE_BYTES } from '../types'
import { assertRegistryID, safeRelativePath } from '../definition'
import { resolveRealInside } from '../artifacts/build'
import { sha256 } from '../digest'
import { buildSkillCandidate, hasComponent } from './common'
import type { SkillAdapterInput, SkillAdapterResult, SkillCandidate } from './types'

interface MarketplaceEntry {
  name: string
  category?: string
  source: unknown
}

function parseMarketplace(raw: unknown): MarketplaceEntry[] {
  if (!raw || typeof raw !== 'object') throw new Error('Codex Marketplace must contain a plugins array')
  const plugins = (raw as Record<string, unknown>).plugins
  if (!Array.isArray(plugins)) throw new Error('Codex Marketplace must contain a plugins array')
  const names = new Set<string>()
  return plugins.map((value, index) => {
    if (!value || typeof value !== 'object') throw new Error(`Marketplace package ${index} must be an object`)
    const item = value as Record<string, unknown>
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

const imageTypes: Record<string, SkillImageContentType> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}

function declaredImagePath(value: unknown, field: string) {
  if (value == null || value === '') return undefined
  if (typeof value !== 'string') throw new Error(`${field} must be a relative image path`)
  const relativePath = safeRelativePath(value, field)
  if (!imageTypes[path.extname(relativePath).toLowerCase()]) throw new Error(`${field} uses an unsupported image type`)
  return relativePath
}

async function readImageAsset(packageRoot: string, relativePath: string) {
  const bytes = new Uint8Array(await readFile(await resolveRealInside(packageRoot, relativePath)))
  if (!bytes.length || bytes.length > MAX_SKILL_IMAGE_BYTES) {
    throw new Error(`Skill image ${relativePath} must be between 1 and ${MAX_SKILL_IMAGE_BYTES} bytes`)
  }
  const descriptor: SkillImageAsset = {
    digest: await sha256(bytes),
    size: bytes.length,
    content_type: imageTypes[path.extname(relativePath).toLowerCase()]!,
  }
  return { descriptor, bytes }
}

async function packageIcon(packageRoot: string, manifest: Record<string, unknown>) {
  const ui = manifest.interface && typeof manifest.interface === 'object'
    ? manifest.interface as Record<string, unknown>
    : {}
  const paths = {
    card: declaredImagePath(ui.composerIcon, 'interface.composerIcon'),
    detail: declaredImagePath(ui.logo, 'interface.logo'),
    dark: declaredImagePath(ui.logoDark, 'interface.logoDark'),
  }
  const brandColor = typeof ui.brandColor === 'string' && /^#[0-9a-f]{6}$/i.test(ui.brandColor)
    ? ui.brandColor.toUpperCase()
    : undefined
  const icon: SkillIcon = { brand_color: brandColor }
  const assets: Array<{ descriptor: SkillImageAsset; bytes: Uint8Array }> = []
  for (const [kind, imagePath] of Object.entries(paths) as Array<[keyof typeof paths, string | undefined]>) {
    if (!imagePath) continue
    const asset = await readImageAsset(packageRoot, imagePath)
    icon[kind] = asset.descriptor
    if (!assets.some((item) => item.descriptor.digest === asset.descriptor.digest)) assets.push(asset)
  }
  return { icon: Object.keys(icon).length ? icon : undefined, assets }
}

async function discoverSkillRoots(packageRoot: string, declaredPath: string) {
  const declaredRoot = await resolveRealInside(packageRoot, declaredPath)
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
    const root = await resolveRealInside(declaredRoot, entry.name)
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

export async function readCodexMarketplace(input: SkillAdapterInput): Promise<SkillAdapterResult> {
  const { definition, sourceRoot, ensurePaths, packageFilter, skillFilter, allowMissingScope } = input
  const catalogPath = await resolveRealInside(sourceRoot, definition.catalog_path!)
  const entries = parseMarketplace(JSON.parse(await readFile(catalogPath, 'utf8')))
    .filter((entry) => !packageFilter || entry.name === packageFilter)
  if (packageFilter && !entries.length) {
    if (allowMissingScope && skillFilter) {
      throw new Error(`${definition.id}/${packageFilter}: package is missing; refresh the whole package`)
    }
    if (allowMissingScope) return { skills: [], diagnostics: [] }
    throw new Error(`${definition.id}: package "${packageFilter}" not found`)
  }
  const packages = entries.map((entry) => {
    const packagePath = localPackagePath(entry.source)
    if (!packagePath) throw new Error(`${definition.id}: package "${entry.name}" uses an unsupported source`)
    return { entry, packagePath }
  })
  await ensurePaths(packages.map(({ packagePath }) => `${packagePath}/.codex-plugin/plugin.json`))

  const prepared: Array<{
    entry: MarketplaceEntry
    packagePath: string
    packageRoot: string
    manifest: Record<string, unknown>
    skillPaths: string[]
    iconPaths: string[]
  }> = []
  const diagnostics: RegistryDiagnostic[] = []
  for (const item of packages) {
    const packageRoot = await resolveRealInside(sourceRoot, item.packagePath)
    const manifestPath = await resolveRealInside(packageRoot, '.codex-plugin/plugin.json')
    const parsed = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${definition.id}: package "${item.entry.name}" manifest must be an object`)
    }
    const manifest = parsed as Record<string, unknown>
    if (String(manifest.name ?? '') !== item.entry.name) {
      throw new Error(`${definition.id}: package "${item.entry.name}" manifest name does not match`)
    }
    const unsupported = ['apps', 'mcpServers', 'hooks'].filter((key) => hasComponent(manifest[key]))
    if (unsupported.length) {
      diagnostics.push({
        package_id: item.entry.name,
        code: 'source_requires_runtime_components',
        message: `Skipped package because it declares: ${unsupported.join(', ')}`,
      })
      continue
    }
    if (!hasComponent(manifest.skills)) {
      diagnostics.push({ package_id: item.entry.name, code: 'no_skills', message: 'Skipped package because it declares no skills' })
      continue
    }
    const skillPaths = codexSkillPaths(manifest.skills)
    const ui = manifest.interface && typeof manifest.interface === 'object'
      ? manifest.interface as Record<string, unknown>
      : {}
    const iconPaths = [
      declaredImagePath(ui.composerIcon, 'interface.composerIcon'),
      declaredImagePath(ui.logo, 'interface.logo'),
      declaredImagePath(ui.logoDark, 'interface.logoDark'),
    ].filter((value): value is string => Boolean(value))
    prepared.push({ ...item, packageRoot, manifest, skillPaths, iconPaths })
  }
  await ensurePaths(prepared.flatMap((item) => [
    ...item.skillPaths.map((skillPath) => `${item.packagePath}/${skillPath}`),
    ...item.iconPaths.map((iconPath) => `${item.packagePath}/${iconPath}`),
  ]))

  const skills: SkillCandidate[] = []
  for (const item of prepared) {
    const presentation = await packageIcon(item.packageRoot, item.manifest)
    const seen = new Set<string>()
    for (const skillPath of item.skillPaths) {
      for (const root of await discoverSkillRoots(item.packageRoot, skillPath)) {
        if (seen.has(root.id)) throw new Error(`${definition.id}/${item.entry.name}: duplicate skill ID ${root.id}`)
        seen.add(root.id)
        if (skillFilter && root.id !== skillFilter) continue
        skills.push(await buildSkillCandidate({
          definition,
          packageID: item.entry.name,
          skillID: root.id,
          sourcePath: `${item.packagePath}/${root.relativePath}`,
          root: root.root,
          allowedRoot: item.packageRoot,
          packageManifest: item.manifest,
          sourceCategory: item.entry.category,
          icon: presentation.icon,
          iconAssets: presentation.assets,
        }))
      }
    }
  }
  if (skillFilter && !skills.length && !allowMissingScope) {
    throw new Error(`${definition.id}/${packageFilter}: skill "${skillFilter}" not found`)
  }
  return { skills, diagnostics }
}
