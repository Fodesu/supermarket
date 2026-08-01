import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { parsePluginManifest } from './manifest'
import { PluginBundleBudget } from './bundle'
import type { TarFileInput } from '#lib/archive'
import type { PluginManifest } from './types'

export interface CommittedPlugin {
  id: string
  manifest: PluginManifest
  files: Record<string, TarFileInput>
}

function isWithin(root: string, candidate: string) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

async function validatePluginTree(root: string, canonicalRepositoryRoot: string) {
  const files: Array<{ path: string; size: number; mode: 0o644 | 0o755 }> = []
  const budget = new PluginBundleBudget()

  const visit = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name)
      const relativePath = path.relative(root, absolutePath).replaceAll(path.sep, '/')
      const stat = await lstat(absolutePath)
      if (stat.isSymbolicLink()) throw new Error(`Plugin content must not contain symbolic links: ${relativePath}`)
      if (!isWithin(canonicalRepositoryRoot, await realpath(absolutePath))) {
        throw new Error(`Plugin content escapes its repository root: ${relativePath}`)
      }
      if (stat.isDirectory()) await visit(absolutePath)
      else if (stat.isFile()) {
        budget.add(relativePath, stat.size)
        files.push({
          path: relativePath,
          size: stat.size,
          mode: stat.mode & 0o111 ? 0o755 : 0o644,
        })
      }
      else throw new Error(`Plugin content contains unsupported file type: ${relativePath}`)
    }
  }

  await visit(root)
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

async function committedPluginRepository(projectRoot: string) {
  const canonicalProjectRoot = await realpath(projectRoot)
  let root = projectRoot
  for (const segment of ['registries', 'memoh', 'plugins']) {
    root = path.join(root, segment)
    if ((await lstat(root)).isSymbolicLink()) {
      throw new Error(`Plugin repository path must not contain symbolic links: ${path.relative(projectRoot, root)}`)
    }
    if (!isWithin(canonicalProjectRoot, await realpath(root))) {
      throw new Error(`Plugin repository path escapes the project root: ${path.relative(projectRoot, root)}`)
    }
  }
  const canonicalRepositoryRoot = await realpath(root)
  const entries = await readdir(root, { withFileTypes: true })
  const unsupportedEntry = entries.find((entry) => !entry.isDirectory())
  if (unsupportedEntry) {
    throw new Error(`Plugin repository entries must be directories: ${unsupportedEntry.name}`)
  }
  return {
    root,
    canonicalRoot: canonicalRepositoryRoot,
    pluginIDs: entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(),
  }
}

export async function loadCommittedPlugins(projectRoot: string): Promise<CommittedPlugin[]> {
  const repository = await committedPluginRepository(projectRoot)
  const failures: Error[] = []
  const plugins: CommittedPlugin[] = []
  for (const pluginID of repository.pluginIDs) {
    const pluginRoot = path.join(repository.root, pluginID)
    try {
      const files = await validatePluginTree(pluginRoot, repository.canonicalRoot)
      const bundledSkill = files.find((file) => file.path === 'skills' || file.path.startsWith('skills/'))
      if (bundledSkill) throw new Error('Plugin Skill content must be published by a Registry and referenced from plugin.yaml')
      const unsupported = files.find((file) => file.path !== 'plugin.yaml'
        && file.path !== 'release.lock.json'
        && file.path !== 'hooks.json'
        && !file.path.startsWith('scripts/'))
      if (unsupported) throw new Error(`Plugin contains unsupported bundle file: ${unsupported.path}`)
      const manifest = parsePluginManifest(await readFile(path.join(pluginRoot, 'plugin.yaml'), 'utf8'), pluginID)
      const bundleFiles: Record<string, TarFileInput> = {}
      for (const file of files) {
        if (file.path !== 'hooks.json' && !file.path.startsWith('scripts/')) continue
        bundleFiles[file.path] = { bytes: new Uint8Array(await readFile(path.join(pluginRoot, file.path))), mode: file.mode }
      }
      plugins.push({ id: pluginID, manifest, files: bundleFiles })
    } catch (error) {
      failures.push(new Error(`${pluginID}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }))
    }
  }
  if (failures.length) throw new AggregateError(failures, failures.map((error) => error.message).join('\n'))
  return plugins
}
