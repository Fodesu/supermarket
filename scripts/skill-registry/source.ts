import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { SkillRegistryDefinition } from '../../server/types/skill-registry'
import { resolveRealInside } from './files'

const maxRegistryRevisionFiles = 100_000
const maxRegistryRevisionBytes = 10 * 1024 * 1024 * 1024

async function exec(command: string, args: string[]) {
  const child = Bun.spawn([command, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ])
  if (exitCode !== 0) throw new Error(`${command} ${args.join(' ')} failed (${exitCode}): ${stderr.trim()}`)
  return stdout.trim()
}

async function directoryRevision(root: string) {
  const physicalRoot = await resolveRealInside(root)
  const hash = createHash('sha256')
  let fileCount = 0
  let totalBytes = 0
  const visit = async (directory: string) => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      const target = path.join(directory, entry.name)
      const stats = await lstat(target)
      if (stats.isSymbolicLink()) throw new Error(`Registry sources cannot contain symlinks: ${target}`)
      if (stats.isDirectory()) {
        await visit(target)
        continue
      }
      if (!stats.isFile()) continue
      fileCount++
      totalBytes += stats.size
      if (fileCount > maxRegistryRevisionFiles || totalBytes > maxRegistryRevisionBytes) {
        throw new Error('Registry source exceeds revision hashing limits')
      }
      hash.update(path.relative(physicalRoot, target).replaceAll(path.sep, '/'))
      hash.update(`\0${stats.mode & 0o777}\0${stats.size}\0`)
      for await (const chunk of createReadStream(target)) hash.update(chunk)
      hash.update('\0')
    }
  }
  await visit(physicalRoot)
  return hash.digest('hex')
}

async function checkoutGit(url: string, ref?: string, sparsePaths: string[] = []) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'supermarket-skills-git-'))
  const repository = path.join(temporaryRoot, 'repository')
  try {
    await exec('git', ['init', repository])
    await exec('git', ['-C', repository, 'remote', 'add', 'origin', url])
    await exec('git', ['-C', repository, 'fetch', '--depth', '1', '--filter=blob:none', 'origin', ref || 'HEAD'])
    if (sparsePaths.length) {
      await exec('git', ['-C', repository, 'sparse-checkout', 'init', '--no-cone'])
      await exec('git', ['-C', repository, 'sparse-checkout', 'set', ...sparsePaths])
    }
    await exec('git', ['-C', repository, 'checkout', '--detach', 'FETCH_HEAD'])
    return { temporaryRoot, repository, revision: await exec('git', ['-C', repository, 'rev-parse', 'HEAD']) }
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true })
    throw error
  }
}

export interface MaterializedSkillRegistrySource {
  root: string
  revision: string
  definition: SkillRegistryDefinition
  ensurePaths(paths: string[]): Promise<void>
  cleanup(): Promise<void>
}

export async function materializeSkillRegistrySource(
  definition: SkillRegistryDefinition,
  projectRoot: string,
): Promise<MaterializedSkillRegistrySource> {
  if (definition.source.type === 'local') {
    const root = await resolveRealInside(projectRoot, definition.source.path)
    return {
      root, revision: await directoryRevision(root), definition,
      ensurePaths: async () => {}, cleanup: async () => {},
    }
  }
  const sourceBase = definition.source.path ?? ''
  const initialPath = definition.adapter === 'codex_marketplace_skills'
    ? [sourceBase, definition.catalog_path].filter(Boolean).join('/')
    : sourceBase
  const checkout = await checkoutGit(definition.source.url, definition.source.ref, initialPath ? [initialPath] : [])
  const selectedPaths = new Set(initialPath ? [initialPath] : [])
  return {
    root: await resolveRealInside(checkout.repository, sourceBase),
    revision: checkout.revision,
    definition,
    ensurePaths: async (paths) => {
      for (const item of paths) selectedPaths.add([sourceBase, item].filter(Boolean).join('/'))
      await exec('git', ['-C', checkout.repository, 'sparse-checkout', 'set', ...selectedPaths])
    },
    cleanup: () => rm(checkout.temporaryRoot, { recursive: true, force: true }),
  }
}
