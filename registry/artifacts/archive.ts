import { createGzipDecoder, createTarDecoder, type ParsedTarEntry } from 'modern-tar'
import {
  assertSafeArchivePath,
  assertSafeArchivePaths,
  MEMOH_DIRECT_OWNER_PATH,
} from '#lib/archive'
import {
  MAX_SKILL_ARTIFACT_ARCHIVE_BYTES,
  MAX_SKILL_ARTIFACT_FILES,
  MAX_SKILL_ARTIFACT_UNCOMPRESSED_BYTES,
} from '../types'

export interface ArchiveFile {
  bytes: Uint8Array
  mode: 0o644 | 0o755
}

async function readEntry(entry: ParsedTarEntry, remainingBytes: number) {
  if (!Number.isSafeInteger(entry.header.size) || entry.header.size < 0 || entry.header.size > remainingBytes) {
    await entry.body.cancel()
    throw new Error('Archive exceeds extraction limits')
  }
  const reader = entry.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > entry.header.size || total > remainingBytes) {
        await reader.cancel()
        throw new Error('Archive exceeds extraction limits')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  if (total !== entry.header.size) throw new Error(`Truncated archive entry: ${entry.header.name}`)
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
}

function limitStream(limit: number, message: string, onComplete?: (size: number) => void) {
  let total = 0
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.length
      if (total > limit) throw new Error(message)
      controller.enqueue(chunk)
    },
    flush() {
      onComplete?.(total)
    },
  })
}

async function parseTarStream(input: ReadableStream<Uint8Array>): Promise<Map<string, ArchiveFile>> {
  const entries = input.pipeThrough(createTarDecoder({ strict: true }))
  const files = new Map<string, ArchiveFile>()
  let totalBytes = 0

  for await (const entry of entries) {
    const name = assertSafeArchivePath(entry.header.name, 'archive')
    if (entry.header.type !== 'file') {
      await entry.body.cancel()
      throw new Error(`Unsupported archive entry type for ${name}`)
    }
    if (files.has(name)) {
      await entry.body.cancel()
      throw new Error(`Duplicate archive entry: ${name}`)
    }
    if (files.size >= MAX_SKILL_ARTIFACT_FILES) {
      await entry.body.cancel()
      throw new Error('Archive exceeds extraction limits')
    }
    const data = await readEntry(entry, MAX_SKILL_ARTIFACT_UNCOMPRESSED_BYTES - totalBytes)
    totalBytes += data.length
    files.set(name, { bytes: data, mode: (entry.header.mode ?? 0) & 0o111 ? 0o755 : 0o644 })
  }

  if (!files.size) throw new Error('Archive contains no files')
  assertSafeArchivePaths(files.keys(), 'archive')
  return files
}

function byteStream(bytes: Uint8Array) {
  return new Blob([bytes.slice().buffer as ArrayBuffer]).stream()
}

export function parseTarArchive(bytes: Uint8Array) {
  return parseTarStream(byteStream(bytes).pipeThrough(
    limitStream(MAX_SKILL_ARTIFACT_ARCHIVE_BYTES, 'Archive exceeds extraction limits'),
  ))
}

export async function parseGzipTarArchiveWithMetrics(
  bytes: Uint8Array,
  limit = MAX_SKILL_ARTIFACT_ARCHIVE_BYTES,
) {
  let archiveSize = 0
  const files = await parseTarStream(byteStream(bytes)
    .pipeThrough(createGzipDecoder())
    .pipeThrough(limitStream(limit, 'Archive exceeds decompression limit', (size) => { archiveSize = size })))
  return {
    files,
    archiveSize,
    fileCount: files.size,
    uncompressedSize: [...files.values()].reduce((total, file) => total + file.bytes.length, 0),
  }
}

export async function parseGzipTarArchive(bytes: Uint8Array, limit = MAX_SKILL_ARTIFACT_ARCHIVE_BYTES) {
  return (await parseGzipTarArchiveWithMetrics(bytes, limit)).files
}

export function validateSkillArchive(files: Map<string, ArchiveFile>) {
  assertSafeArchivePaths(files.keys(), 'Skill archive', {
    reservedRootPaths: [MEMOH_DIRECT_OWNER_PATH],
  })
  if (!files.has('SKILL.md')) throw new Error('Skill archive does not contain SKILL.md at its root')
}
