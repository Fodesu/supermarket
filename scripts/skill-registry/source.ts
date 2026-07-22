import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { SkillRegistryDefinition } from '../../server/types/skill-registry'
import { sha256 } from '../../server/utils/skill-registry-store'
import { readDirectoryFiles, resolveInside } from './files'

async function exec(command: string, args: string[]) {
  const child = Bun.spawn([command, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ])
  if (exitCode !== 0) throw new Error(`${command} ${args.join(' ')} failed (${exitCode}): ${stderr.trim()}`)
  return stdout.trim()
}

async function directoryRevision(root: string) {
  const files = await readDirectoryFiles(root)
  const parts: string[] = []
  for (const [name, bytes] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    parts.push(name, await sha256(bytes))
  }
  return sha256(parts.join('\n'))
}

async function checkoutGit(url: string, ref?: string, sparsePaths: string[] = []) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'supermarket-skills-git-'))
  const repository = path.join(temporaryRoot, 'repository')
  try {
    await exec('git', ['clone', '--filter=blob:none', '--no-checkout', url, repository])
    await exec('git', ['-C', repository, 'fetch', '--depth', '1', 'origin', ref || 'HEAD'])
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
    const root = resolveInside(projectRoot, definition.source.path)
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
    root: resolveInside(checkout.repository, sourceBase),
    revision: checkout.revision,
    definition,
    ensurePaths: async (paths) => {
      for (const item of paths) selectedPaths.add([sourceBase, item].filter(Boolean).join('/'))
      await exec('git', ['-C', checkout.repository, 'sparse-checkout', 'set', ...selectedPaths])
    },
    cleanup: () => rm(checkout.temporaryRoot, { recursive: true, force: true }),
  }
}
