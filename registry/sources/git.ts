import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { SkillRegistryDefinition } from '../types'
import { resolveRealInside } from '../filesystem'
import type { MaterializedSkillRegistrySource } from './types'
import {
  MAX_REGISTRY_GIT_TREE_BYTES,
  MAX_REGISTRY_SOURCE_BYTES,
  MAX_REGISTRY_SOURCE_FILES,
} from '../budget'

const gitCommandTimeoutMs = 2 * 60 * 1000
const gitFetchTimeoutMs = 15 * 60 * 1000
const isolatedGitEnvironment = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ATTR_NOSYSTEM: '1',
}

async function exec(
  command: string,
  args: string[],
  timeoutMs = gitCommandTimeoutMs,
  trim = true,
  stdin?: Uint8Array,
  extraEnv: Record<string, string> = {},
  fileLimitBytes?: number,
) {
  const invocation = fileLimitBytes === undefined
    ? [command, ...args]
    : [
        '/bin/sh', '-c', 'ulimit -f "$1" || exit 125; shift; exec "$@"',
        'registry-git-limit', String(Math.max(1, Math.ceil(fileLimitBytes / 512))),
        command, ...args,
      ]
  const child = Bun.spawn(invocation, {
    stdin: stdin ?? 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...isolatedGitEnvironment, ...extraEnv },
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill(9)
  }, timeoutMs)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (timedOut) throw new Error(`${command} ${args.join(' ')} timed out after ${timeoutMs}ms`)
    if (exitCode !== 0) throw new Error(`${command} ${args.join(' ')} failed (${exitCode}): ${stderr.trim()}`)
    return trim ? stdout.trim() : stdout
  } finally {
    clearTimeout(timer)
  }
}

export function assertGitTreeMaterialization(
  listing: string,
  fileLimit = MAX_REGISTRY_SOURCE_FILES,
  byteLimit = MAX_REGISTRY_SOURCE_BYTES,
  metadataLimit = MAX_REGISTRY_GIT_TREE_BYTES,
) {
  const metadataSize = new TextEncoder().encode(listing).byteLength
  if (metadataSize > metadataLimit) {
    throw new Error(`Git tree metadata exceeds ${metadataLimit} bytes`)
  }
  const state = { fileCount: 0, sourceBytes: 0 }
  for (const record of listing.split('\0')) {
    if (!record) continue
    addGitTreeRecord(record, state, fileLimit, byteLimit)
  }
  return state
}

function addGitTreeRecord(
  record: string,
  state: { fileCount: number; sourceBytes: number },
  fileLimit: number,
  byteLimit: number,
) {
  const { mode, type, object, size, sourcePath } = parseGitTreeRecord(record)
  const blobSize = /^\d+$/.test(size ?? '') ? Number(size) : Number.NaN
  if (!Number.isSafeInteger(blobSize)) {
    throw new Error(`Git source contains an unsupported tree entry: ${sourcePath || '<unknown>'}`)
  }
  assertSupportedGitTreeEntry(mode, type, object, sourcePath)
  addGitTreeFile(state, fileLimit)
  if (blobSize > byteLimit - state.sourceBytes) {
    throw new Error(`Git source materialization exceeds ${byteLimit} bytes`)
  }
  state.sourceBytes += blobSize
}

function parseGitTreeRecord(record: string) {
  const separator = record.indexOf('\t')
  if (separator < 0) throw new Error('Git returned malformed tree metadata')
  const [mode, type, object, size, ...extra] = record.slice(0, separator).trim().split(/\s+/)
  const sourcePath = record.slice(separator + 1)
  if (extra.length) throw new Error('Git returned malformed tree metadata')
  return { mode, type, object, size, sourcePath }
}

function assertSupportedGitTreeEntry(
  mode: string | undefined,
  type: string | undefined,
  object: string | undefined,
  sourcePath: string,
) {
  if (!/^100(?:644|755)$/.test(mode ?? '') || type !== 'blob'
    || !/^[a-f0-9]{40,64}$/.test(object ?? '') || !sourcePath) {
    throw new Error(`Git source contains an unsupported tree entry: ${sourcePath || '<unknown>'}`)
  }
}

function addGitTreeFile(state: { fileCount: number }, fileLimit: number) {
  state.fileCount++
  if (state.fileCount > fileLimit) {
    throw new Error(`Git source materialization exceeds ${fileLimit} files`)
  }
}

function assertSparsePath(sourcePath: string) {
  if (!sourcePath || sourcePath.includes('\0') || /[\\\r\n*?!#]/u.test(sourcePath)
    || /[ \t]$/u.test(sourcePath) || sourcePath.includes('[') || sourcePath.includes(']')) {
    throw new Error(`Git source path cannot be represented safely in a sparse checkout: ${sourcePath}`)
  }
  return sourcePath
}

export function gitSparsePattern(sourcePath: string) {
  return `/${assertSparsePath(sourcePath)}`
}

const lineInput = (values: Iterable<string>) =>
  new TextEncoder().encode(`${[...values].join('\n')}\n`)

async function setSparsePaths(repository: string, paths: string[]) {
  const patterns = paths.map(gitSparsePattern)
  await exec(
    'git',
    ['-C', repository, 'sparse-checkout', 'set', '--no-cone', '--stdin'],
    gitCommandTimeoutMs,
    true,
    lineInput(patterns),
  )
}

async function selectedGitObjects(
  repository: string,
  revision: string,
  paths: string[],
  materialized = true,
) {
  const selected = paths.map((sourcePath) => `:(literal)${assertSparsePath(sourcePath)}`)
  const args = ['-C', repository, 'ls-tree', '-r', '-z', revision]
  if (selected.length) args.push('--', ...selected)
  const child = Bun.spawn(['git', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...isolatedGitEnvironment },
  })
  const stderrPromise = new Response(child.stderr).text()
  const exitedPromise = child.exited
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill(9)
  }, gitCommandTimeoutMs)
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const state = { fileCount: 0 }
  const objects = new Map<string, number>()
  let metadataSize = 0
  let pending = ''
  try {
    const reader = child.stdout.getReader()
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      metadataSize += value.byteLength
      if (metadataSize > MAX_REGISTRY_GIT_TREE_BYTES) {
        throw new Error(`Git tree metadata exceeds ${MAX_REGISTRY_GIT_TREE_BYTES} bytes`)
      }
      pending += decoder.decode(value, { stream: true })
      let separator = pending.indexOf('\0')
      while (separator >= 0) {
        const record = pending.slice(0, separator)
        pending = pending.slice(separator + 1)
        if (record) {
          const { mode, type, object, size, sourcePath } = parseGitTreeRecord(record)
          if (size !== undefined) throw new Error('Git returned malformed tree metadata')
          if (materialized) {
            assertSupportedGitTreeEntry(mode, type, object, sourcePath)
          } else if (!/^[a-f0-9]{40,64}$/.test(object ?? '') || !sourcePath) {
            throw new Error('Git returned malformed tree metadata')
          }
          addGitTreeFile(state, MAX_REGISTRY_SOURCE_FILES)
          if (materialized) objects.set(object!, (objects.get(object!) ?? 0) + 1)
        }
        separator = pending.indexOf('\0')
      }
    }
    pending += decoder.decode()
    if (pending) throw new Error('Git returned malformed tree metadata')
    const [stderr, exitCode] = await Promise.all([stderrPromise, exitedPromise])
    if (timedOut) throw new Error(`git ${args.join(' ')} timed out after ${gitCommandTimeoutMs}ms`)
    if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed (${exitCode}): ${stderr.trim()}`)
    return objects
  } catch (error) {
    child.kill(9)
    await Promise.allSettled([stderrPromise, exitedPromise])
    if (timedOut) throw new Error(`git ${args.join(' ')} timed out after ${gitCommandTimeoutMs}ms`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function inspectGitObjectSizes(
  repository: string,
  objects: Map<string, number>,
) {
  if (!objects.size) return { sourceBytes: 0, missing: [] as string[] }
  const output = await exec(
    'git',
    ['-C', repository, 'cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
    gitCommandTimeoutMs,
    true,
    lineInput(objects.keys()),
    { GIT_NO_LAZY_FETCH: '1' },
  )
  const missing: string[] = []
  const seen = new Set<string>()
  let sourceBytes = 0
  for (const line of output.split('\n')) {
    if (!line) continue
    const [object, type, size, ...extra] = line.trim().split(/\s+/)
    const occurrences = objects.get(object ?? '')
    if (extra.length || !occurrences || seen.has(object!)) {
      throw new Error('Git returned malformed object metadata')
    }
    seen.add(object!)
    if (type === 'missing' && size === undefined) {
      missing.push(object!)
      continue
    }
    const blobSize = /^\d+$/.test(size ?? '') ? Number(size) : Number.NaN
    if (type !== 'blob' || !Number.isSafeInteger(blobSize)) {
      throw new Error(`Git source contains an unsupported object: ${object}`)
    }
    if (blobSize > Math.floor((MAX_REGISTRY_SOURCE_BYTES - sourceBytes) / occurrences)) {
      throw new Error(`Git source materialization exceeds ${MAX_REGISTRY_SOURCE_BYTES} bytes`)
    }
    sourceBytes += blobSize * occurrences
  }
  if (seen.size !== objects.size) throw new Error('Git omitted selected object metadata')
  return { sourceBytes, missing }
}

async function assertMaterializationBudget(
  repository: string,
  revision: string,
  paths: string[],
  requirePromisedObjects = false,
) {
  const objects = await selectedGitObjects(repository, revision, paths)
  const inspected = await inspectGitObjectSizes(repository, objects)
  if (requirePromisedObjects && inspected.missing.length !== objects.size) {
    throw new Error('Git source remote did not honor blob filtering')
  }
  if (inspected.missing.length) {
    const remaining = MAX_REGISTRY_SOURCE_BYTES - inspected.sourceBytes
    await exec(
      'git',
      [
        '-C', repository, 'fetch', '--quiet', '--no-progress', '--no-tags',
        '--no-write-fetch-head', '--no-auto-maintenance', '--keep',
        `--filter=blob:limit=${remaining + 1}`, '--stdin', 'origin',
      ],
      gitFetchTimeoutMs,
      true,
      lineInput(inspected.missing),
      {},
      remaining + MAX_REGISTRY_GIT_TREE_BYTES,
    )
    const fetched = await inspectGitObjectSizes(repository, objects)
    if (fetched.missing.length) {
      throw new Error(`Git source materialization exceeds ${MAX_REGISTRY_SOURCE_BYTES} bytes`)
    }
  }
}

async function checkoutGit(url: string, revision: string, sparsePaths: string[] = []) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'supermarket-skills-git-'))
  const repository = path.join(temporaryRoot, 'repository')
  try {
    await exec('git', ['init', repository])
    const emptyAttributeTree = await exec('git', ['-C', repository, 'mktree'])
    await exec('git', ['-C', repository, 'config', 'attr.tree', emptyAttributeTree])
    await exec('git', ['-C', repository, 'config', 'core.attributesFile', '/dev/null'])
    await exec('git', ['-C', repository, 'config', 'core.autocrlf', 'false'])
    await exec('git', ['-C', repository, 'remote', 'add', 'origin', url])
    await exec(
      'git',
      [
        '-C', repository, 'fetch', '--quiet', '--no-progress', '--no-tags', '--keep',
        '--depth', '1', '--filter=blob:none', 'origin', revision,
      ],
      gitFetchTimeoutMs,
      true,
      undefined,
      {},
      MAX_REGISTRY_GIT_TREE_BYTES * 2,
    )
    await selectedGitObjects(repository, 'FETCH_HEAD', [], false)
    await assertMaterializationBudget(repository, 'FETCH_HEAD', sparsePaths, true)
    if (sparsePaths.length) {
      await exec('git', ['-C', repository, 'sparse-checkout', 'init', '--no-cone'])
      await setSparsePaths(repository, sparsePaths)
    }
    await exec('git', ['-C', repository, 'checkout', '--detach', 'FETCH_HEAD'])
    const resolvedRevision = await exec('git', ['-C', repository, 'rev-parse', 'HEAD'])
    if (resolvedRevision !== revision) {
      throw new Error(`Git source resolved an unexpected revision: expected ${revision}, got ${resolvedRevision}`)
    }
    return {
      temporaryRoot,
      repository,
      revision: resolvedRevision,
    }
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true })
    throw error
  }
}

export async function materializeGitSource(
  definition: SkillRegistryDefinition,
  bootstrapPaths: string[] = [],
): Promise<MaterializedSkillRegistrySource> {
  if (definition.source.type !== 'git') throw new Error('Expected a Git Registry source')
  const sourceBase = definition.source.path ?? ''
  const initialPaths = bootstrapPaths.length
    ? bootstrapPaths.map((item) => [sourceBase, item].filter(Boolean).join('/'))
    : sourceBase ? [sourceBase] : []
  const checkout = await checkoutGit(
    definition.source.url,
    definition.source.revision,
    initialPaths,
  )
  try {
    const selectedPaths = new Set(initialPaths)
    return {
      root: await resolveRealInside(checkout.repository, sourceBase),
      revision: checkout.revision,
      definition,
      ensurePaths: async (paths) => {
        for (const item of paths) selectedPaths.add([sourceBase, item].filter(Boolean).join('/'))
        if (selectedPaths.size) {
          await assertMaterializationBudget(
            checkout.repository,
            checkout.revision,
            [...selectedPaths],
          )
          await setSparsePaths(checkout.repository, [...selectedPaths])
        }
      },
      cleanup: () => rm(checkout.temporaryRoot, { recursive: true, force: true }),
    }
  } catch (error) {
    await rm(checkout.temporaryRoot, { recursive: true, force: true })
    throw error
  }
}
