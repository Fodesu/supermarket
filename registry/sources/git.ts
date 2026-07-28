import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { SkillRegistryDefinition } from '../types'
import { resolveRealInside } from '../artifacts/build'
import type { MaterializedSkillRegistrySource } from './types'

async function exec(command: string, args: string[], timeoutMs?: number) {
  const child = Bun.spawn([command, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const timer = timeoutMs ? setTimeout(() => child.kill(), timeoutMs) : undefined
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (exitCode !== 0) throw new Error(`${command} ${args.join(' ')} failed (${exitCode}): ${stderr.trim()}`)
    return stdout.trim()
  } finally {
    if (timer) clearTimeout(timer)
  }
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
    return {
      temporaryRoot,
      repository,
      revision: await exec('git', ['-C', repository, 'rev-parse', 'HEAD']),
    }
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true })
    throw error
  }
}

export async function materializeGitSource(
  definition: SkillRegistryDefinition,
): Promise<MaterializedSkillRegistrySource> {
  if (definition.source.type !== 'git') throw new Error('Expected a Git Registry source')
  const sourceBase = definition.source.path ?? ''
  const initialPath = definition.adapter === 'codex_marketplace_skills'
    ? [sourceBase, definition.catalog_path].filter(Boolean).join('/')
    : sourceBase
  const checkout = await checkoutGit(
    definition.source.url,
    definition.source.ref,
    initialPath ? [initialPath] : [],
  )
  try {
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
  } catch (error) {
    await rm(checkout.temporaryRoot, { recursive: true, force: true })
    throw error
  }
}
