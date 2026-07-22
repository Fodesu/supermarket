import { chmod, lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  MAX_SKILL_ARTIFACT_FILES,
  MAX_SKILL_ARTIFACT_UNCOMPRESSED_BYTES,
} from '../server/types/skill-registry'

const decoder = new TextDecoder()
const blockSize = 512

export interface ArchiveFile {
  bytes: Uint8Array
  mode: 0o644 | 0o755
}

function stringField(header: Uint8Array, offset: number, length: number) {
  return decoder.decode(header.subarray(offset, offset + length)).replace(/\0.*$/, '').trim()
}

function octalField(header: Uint8Array, offset: number, length: number) {
  const value = stringField(header, offset, length).replace(/\0/g, '').trim()
  if (!/^[0-7]*$/.test(value)) throw new Error('Invalid tar numeric field')
  return value ? Number.parseInt(value, 8) : 0
}

function safeArchivePath(name: string) {
  if (name.includes('\\')) throw new Error(`Unsafe archive path: ${name}`)
  const normalized = name
  const segments = normalized.split('/')
  if (!normalized || normalized.startsWith('/') || segments.includes('..') || segments.includes('') || /^[a-z]:/i.test(normalized)) {
    throw new Error(`Unsafe archive path: ${name}`)
  }
  return normalized
}

function verifyChecksum(header: Uint8Array) {
  const expected = octalField(header, 148, 8)
  let actual = 0
  for (let index = 0; index < header.length; index++) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index] ?? 0
  }
  if (expected !== actual) throw new Error('Invalid tar header checksum')
}

export function parseTarArchive(bytes: Uint8Array): Map<string, ArchiveFile> {
  const files = new Map<string, ArchiveFile>()
  let offset = 0
  let totalBytes = 0
  while (offset + blockSize <= bytes.length) {
    const header = bytes.subarray(offset, offset + blockSize)
    if (header.every((value) => value === 0)) break
    verifyChecksum(header)
    const name = safeArchivePath([stringField(header, 345, 155), stringField(header, 0, 100)].filter(Boolean).join('/'))
    const rawMode = octalField(header, 100, 8)
    const size = octalField(header, 124, 12)
    const type = header[156]
    offset += blockSize
    if (offset + size > bytes.length) throw new Error(`Truncated archive entry: ${name}`)
    if (type !== 0 && type !== 0x30) throw new Error(`Unsupported archive entry type for ${name}`)
    if (files.has(name)) throw new Error(`Duplicate archive entry: ${name}`)
    totalBytes += size
    if (files.size >= MAX_SKILL_ARTIFACT_FILES || totalBytes > MAX_SKILL_ARTIFACT_UNCOMPRESSED_BYTES) {
      throw new Error('Archive exceeds extraction limits')
    }
    files.set(name, { bytes: bytes.slice(offset, offset + size), mode: rawMode & 0o111 ? 0o755 : 0o644 })
    offset += Math.ceil(size / blockSize) * blockSize
  }
  if (!files.size) throw new Error('Archive contains no files')
  for (const name of files.keys()) {
    const segments = name.split('/')
    for (let index = 1; index < segments.length; index++) {
      if (files.has(segments.slice(0, index).join('/'))) throw new Error(`Archive contains a conflicting path: ${name}`)
    }
  }
  return files
}

export async function gunzip(bytes: Uint8Array, limit = MAX_SKILL_ARTIFACT_UNCOMPRESSED_BYTES) {
  const stream = new Blob([bytes.slice().buffer as ArrayBuffer]).stream().pipeThrough(new DecompressionStream('gzip'))
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > limit) {
      await reader.cancel()
      throw new Error('Archive exceeds decompression limit')
    }
    chunks.push(value)
  }
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }
  return output
}

export function validateSkillArchive(files: Map<string, ArchiveFile>, installID: string) {
  const prefix = `${installID}/`
  if (!files.has(`${prefix}SKILL.md`)) throw new Error('Skill archive does not contain SKILL.md at its root')
  for (const name of files.keys()) {
    if (!name.startsWith(prefix)) throw new Error(`Archive entry is outside the Skill root: ${name}`)
  }
}

export async function extractSkillArchive(files: Map<string, ArchiveFile>, destination: string, installID: string) {
  validateSkillArchive(files, installID)
  const root = path.resolve(destination, installID)
  await mkdir(path.dirname(root), { recursive: true })
  const lockPath = `${root}.install-lock`
  let lock
  try {
    lock = await open(lockPath, 'wx')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Install destination is locked: ${root}`)
    }
    throw error
  }
  try {
    try {
      await lstat(root)
      throw new Error(`Install destination already exists: ${root}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const temporary = `${root}.tmp-${crypto.randomUUID()}`
    const prefix = `${installID}/`
    try {
      for (const [name, file] of files) {
        const relative = name.slice(prefix.length)
        const target = path.resolve(temporary, relative)
        if (!target.startsWith(`${temporary}${path.sep}`)) throw new Error(`Archive path escapes destination: ${name}`)
        await mkdir(path.dirname(target), { recursive: true })
        await writeFile(target, file.bytes, { flag: 'wx', mode: file.mode })
        await chmod(target, file.mode)
      }
      await rename(temporary, root)
      return root
    } catch (error) {
      await rm(temporary, { recursive: true, force: true })
      throw error
    }
  } finally {
    await lock.close()
    await rm(lockPath, { force: true })
  }
}
