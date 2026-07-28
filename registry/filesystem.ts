import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { MAX_SKILL_ARTIFACT_FILES, MAX_SKILL_ARTIFACT_UNCOMPRESSED_BYTES } from './types'
import type { TarFileInput } from '#archive/tar'

const ignoredDirectories = new Set(['.git', 'node_modules'])

export type SkillSourceFile = TarFileInput

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
        if (stats.size > MAX_SKILL_ARTIFACT_UNCOMPRESSED_BYTES - totalBytes) {
          throw new Error(`Skill package exceeds ${MAX_SKILL_ARTIFACT_UNCOMPRESSED_BYTES} bytes`)
        }
        const bytes = new Uint8Array(await readFile(target))
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
