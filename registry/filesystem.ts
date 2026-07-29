import { lstat, open, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { MAX_SKILL_ARTIFACT_FILES, MAX_SKILL_ARTIFACT_UNCOMPRESSED_BYTES } from './types'
import type { TarFileInput } from '#lib/archive'

const ignoredDirectories = new Set(['.git', 'node_modules'])

export type SkillSourceFile = TarFileInput

export async function readFileBounded(target: string, maximum: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximum) || maximum < 0) throw new Error(`Invalid file limit: ${maximum}`)
  const handle = await open(target, 'r')
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`Expected regular file: ${target}`)
    const chunks: Uint8Array[] = []
    let total = 0
    while (true) {
      const buffer = new Uint8Array(Math.min(64 * 1024, maximum - total + 1))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      total += bytesRead
      if (total > maximum) throw new Error(`File exceeds ${maximum} bytes: ${target}`)
      chunks.push(buffer.subarray(0, bytesRead))
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    return bytes
  } finally {
    await handle.close()
  }
}

export function resolveInside(root: string, relativePath = ''): string {
  const resolvedRoot = path.resolve(root)
  const target = path.resolve(root, relativePath)
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Path escapes source: ${relativePath}`)
  }
  return target
}

function assertPhysicalContainment(root: string, target: string) {
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Path escapes source through a symlink: ${target}`)
  }
}

export async function resolveRealInside(root: string, relativePath = '') {
  const physicalRoot = await realpath(path.resolve(root))
  const physicalTarget = await realpath(resolveInside(root, relativePath))
  assertPhysicalContainment(physicalRoot, physicalTarget)
  return physicalTarget
}

export async function readDirectoryFiles(root: string, allowedRoot = root): Promise<Record<string, SkillSourceFile>> {
  const physicalAllowedRoot = await realpath(path.resolve(allowedRoot))
  const physicalRoot = await realpath(path.resolve(root))
  assertPhysicalContainment(physicalAllowedRoot, physicalRoot)
  const files: Record<string, SkillSourceFile> = {}
  let totalBytes = 0
  let fileCount = 0
  const visit = async (directory: string) => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (ignoredDirectories.has(entry.name)) continue
      const target = path.join(directory, entry.name)
      const stats = await lstat(target)
      if (stats.isSymbolicLink()) throw new Error(`Skill packages cannot contain symlinks: ${target}`)
      if (stats.isDirectory()) await visit(target)
      else if (stats.isFile()) {
        if (fileCount >= MAX_SKILL_ARTIFACT_FILES) throw new Error(`Skill package exceeds ${MAX_SKILL_ARTIFACT_FILES} files`)
        const bytes = await readFileBounded(target, MAX_SKILL_ARTIFACT_UNCOMPRESSED_BYTES - totalBytes)
        fileCount++
        totalBytes += bytes.length
        if (totalBytes > MAX_SKILL_ARTIFACT_UNCOMPRESSED_BYTES) {
          throw new Error(`Skill package exceeds ${MAX_SKILL_ARTIFACT_UNCOMPRESSED_BYTES} bytes`)
        }
        const name = path.relative(physicalRoot, target).replaceAll(path.sep, '/')
        files[name] = { bytes, mode: stats.mode & 0o111 ? 0o755 : 0o644 }
      }
    }
  }
  await visit(physicalRoot)
  return files
}
