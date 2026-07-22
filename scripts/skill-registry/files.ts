import { lstat, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { MAX_SKILL_ARTIFACT_COMPRESSED_BYTES } from '../../server/types/skill-registry'
import { createTar, gzip } from '../../server/utils/tar'
import { sha256 } from '../../server/utils/skill-registry-store'

const ignoredDirectories = new Set(['.git', 'node_modules'])
const maxFiles = 10_000
const maxBytes = 100 * 1024 * 1024

export function resolveInside(root: string, relativePath = ''): string {
  const resolvedRoot = path.resolve(root)
  const target = path.resolve(root, relativePath)
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Path escapes source: ${relativePath}`)
  }
  return target
}

export async function readDirectoryFiles(root: string): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = {}
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
        if (fileCount >= maxFiles) throw new Error(`Skill package exceeds ${maxFiles} files`)
        const bytes = new Uint8Array(await readFile(target))
        fileCount++
        totalBytes += bytes.length
        if (totalBytes > maxBytes) throw new Error(`Skill package exceeds ${maxBytes} bytes`)
        files[path.relative(root, target).replaceAll(path.sep, '/')] = bytes
      }
    }
  }
  await visit(root)
  return files
}

export async function packageSkill(files: Record<string, Uint8Array>, installID: string) {
  const bytes = await gzip(createTar(files, installID))
  if (bytes.length > MAX_SKILL_ARTIFACT_COMPRESSED_BYTES) {
    throw new Error(`Compressed Skill Artifact exceeds ${MAX_SKILL_ARTIFACT_COMPRESSED_BYTES} bytes`)
  }
  return { bytes, digest: await sha256(bytes) }
}
