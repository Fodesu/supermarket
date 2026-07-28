import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { parseBundledSkillDocument, parsePluginManifest } from './manifest'

function isWithin(root: string, candidate: string) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

async function validatePluginTree(root: string, canonicalRepositoryRoot: string) {
  const files: string[] = []

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
      else if (stat.isFile()) files.push(relativePath)
      else throw new Error(`Plugin content contains unsupported file type: ${relativePath}`)
    }
  }

  await visit(root)
  return files.sort()
}

export async function validateCommittedPlugins(projectRoot: string) {
  const root = path.join(projectRoot, 'registries/memoh/plugins')
  if ((await lstat(root)).isSymbolicLink()) {
    throw new Error('Plugin repository root must not be a symbolic link')
  }
  const canonicalRepositoryRoot = await realpath(root)
  const entries = await readdir(root, { withFileTypes: true })
  const unsupportedEntry = entries.find((entry) => !entry.isDirectory())
  if (unsupportedEntry) {
    throw new Error(`Plugin repository entries must be directories: ${unsupportedEntry.name}`)
  }
  const pluginIDs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  const failures: Error[] = []
  for (const pluginID of pluginIDs) {
    const pluginRoot = path.join(root, pluginID)
    try {
      const files = await validatePluginTree(pluginRoot, canonicalRepositoryRoot)
      parsePluginManifest(await readFile(path.join(pluginRoot, 'plugin.yaml'), 'utf8'), pluginID)
      for (const relativePath of files.filter((file) => /^skills\/[^/]+\/SKILL\.md$/.test(file))) {
        const skillID = path.basename(path.dirname(relativePath))
        parseBundledSkillDocument(`${pluginID}/${skillID}`, await readFile(path.join(pluginRoot, relativePath), 'utf8'))
      }
    } catch (error) {
      failures.push(new Error(`${pluginID}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }))
    }
  }
  if (failures.length) throw new AggregateError(failures, failures.map((error) => error.message).join('\n'))
  return pluginIDs
}
