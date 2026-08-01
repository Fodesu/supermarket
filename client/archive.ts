import { chmod, lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  validateSkillArchive,
  type ArchiveFile,
} from '#registry/artifacts/archive'

export {
  parseGzipTarArchive,
  parseGzipTarArchiveWithMetrics,
  parseTarArchive,
  validateSkillArchive,
  type ArchiveFile,
} from '#registry/artifacts/archive'

export async function extractSkillArchive(files: Map<string, ArchiveFile>, destination: string, installID: string) {
  validateSkillArchive(files)
  const destinationRoot = path.resolve(destination)
  const root = path.resolve(destinationRoot, installID)
  if (!installID || path.isAbsolute(installID)
    || root === destinationRoot || !root.startsWith(`${destinationRoot}${path.sep}`)) {
    throw new Error(`Install identity escapes destination: ${installID}`)
  }
  await mkdir(path.dirname(root), { recursive: true })
  try {
    await lstat(root)
    throw new Error(`Install destination already exists: ${root}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const temporary = `${root}.tmp-${crypto.randomUUID()}`
  let claimedRoot = false
  try {
    for (const [name, file] of files) {
      const target = path.resolve(temporary, name)
      if (!target.startsWith(`${temporary}${path.sep}`)) throw new Error(`Archive path escapes destination: ${name}`)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, file.bytes, { flag: 'wx', mode: file.mode })
      await chmod(target, file.mode)
    }
    if (process.platform !== 'win32') {
      await mkdir(root)
      claimedRoot = true
    }
    await rename(temporary, root)
    return root
  } catch (error) {
    await rm(temporary, { recursive: true, force: true })
    if (claimedRoot) await rm(root, { recursive: true, force: true })
    throw error
  }
}
