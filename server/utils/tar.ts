import { MAX_SKILL_ARTIFACT_UNCOMPRESSED_BYTES } from '../types/skill-registry'

const BLOCK_SIZE = 512

export interface TarFileInput {
  bytes: Uint8Array
  mode: 0o644 | 0o755
}

function encodeOctal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, '0') + '\0'
}

function createHeader(filename: string, size: number, mode: 0o644 | 0o755): Uint8Array {
  const header = new Uint8Array(BLOCK_SIZE)
  const encoder = new TextEncoder()

  const writeStr = (str: string, offset: number, len: number) => {
    const bytes = encoder.encode(str)
    header.set(bytes.subarray(0, len), offset)
  }

  let name = filename
  let prefix = ''
  if (encoder.encode(name).length > 100) {
    const separators = [...filename.matchAll(/\//g)].map((match) => match.index).reverse()
    const split = separators.find((index) =>
      encoder.encode(filename.slice(0, index)).length <= 155 && encoder.encode(filename.slice(index + 1)).length <= 100,
    )
    if (split == null) throw new Error(`Tar path is too long: ${filename}`)
    prefix = filename.slice(0, split)
    name = filename.slice(split + 1)
  }
  writeStr(name, 0, 100)
  writeStr(encodeOctal(mode, 8), 100, 8)     // mode
  writeStr(encodeOctal(0, 8), 108, 8)        // uid
  writeStr(encodeOctal(0, 8), 116, 8)        // gid
  writeStr(encodeOctal(size, 12), 124, 12)   // size
  writeStr(encodeOctal(0, 12), 136, 12)        // deterministic mtime
  writeStr('        ', 148, 8)               // checksum placeholder (spaces)
  header[156] = 0x30                         // '0' = regular file
  writeStr('ustar\0', 257, 6)               // magic
  writeStr('00', 263, 2)                     // version
  writeStr(prefix, 345, 155)                 // ustar path prefix

  let checksum = 0
  for (let i = 0; i < BLOCK_SIZE; i++) {
    checksum += header[i] ?? 0
  }
  writeStr(encodeOctal(checksum, 7) + ' ', 148, 8)

  return header
}

export function createTar(files: Record<string, Uint8Array | TarFileInput>, prefix: string): Uint8Array {
  const parts: Uint8Array[] = []
  const paths = new Set<string>()
  let totalLen = BLOCK_SIZE * 2

  for (const [name, input] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    const segments = name.split('/')
    if (!name || name.includes('\\') || name.startsWith('/') || /^[a-z]:/i.test(name)
      || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
      throw new Error(`Unsafe tar path: ${name}`)
    }
    const archivePath = prefix ? `${prefix}/${name}` : name
    if (paths.has(archivePath)) throw new Error(`Duplicate tar path: ${archivePath}`)
    paths.add(archivePath)
    const data = input instanceof Uint8Array ? input : input.bytes
    const mode = input instanceof Uint8Array ? 0o644 : input.mode
    const padding = (BLOCK_SIZE - (data.length % BLOCK_SIZE)) % BLOCK_SIZE
    totalLen += BLOCK_SIZE + data.length + padding
    if (totalLen > MAX_SKILL_ARTIFACT_UNCOMPRESSED_BYTES) {
      throw new Error(`Skill Artifact exceeds ${MAX_SKILL_ARTIFACT_UNCOMPRESSED_BYTES} uncompressed bytes`)
    }
    parts.push(createHeader(archivePath, data.length, mode === 0o755 ? 0o755 : 0o644))
    parts.push(data)

    if (padding > 0) parts.push(new Uint8Array(padding))
  }

  parts.push(new Uint8Array(BLOCK_SIZE * 2))

  const result = new Uint8Array(totalLen)
  let offset = 0
  for (const p of parts) {
    result.set(p, offset)
    offset += p.length
  }
  return result
}

export async function gzip(data: Uint8Array): Promise<Uint8Array> {
  const input = new Uint8Array(data.length)
  input.set(data)
  const stream = new Blob([input]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}
