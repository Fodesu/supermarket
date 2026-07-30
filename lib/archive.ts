import { createGzipEncoder, packTar, type TarEntry } from 'modern-tar'
import { compareCanonicalText } from './order'

export const MAX_TAR_UNCOMPRESSED_BYTES = 5 * 1024 * 1024
const gzipHeaderLength = 10
const gzipMinimumLength = gzipHeaderLength + 8

export interface TarFileInput {
  bytes: Uint8Array
  mode: 0o644 | 0o755
}

export function assertSafeArchivePath(name: string, label = 'tar') {
  const segments = name.split('/')
  if (!name || name.includes('\\') || name.startsWith('/') || /^[a-z]:/i.test(name)
    || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Unsafe ${label} path: ${name}`)
  }
  return name
}

export async function createTar(
  files: Record<string, Uint8Array | TarFileInput>,
  prefix: string,
): Promise<Uint8Array> {
  if (prefix) assertSafeArchivePath(prefix)
  let contentBytes = 0
  const entries: TarEntry[] = Object.entries(files)
    .sort(([left], [right]) => compareCanonicalText(left, right))
    .map(([name, input]) => {
      assertSafeArchivePath(name)
      const archivePath = prefix ? `${prefix}/${name}` : name
      assertSafeArchivePath(archivePath)
      const body = input instanceof Uint8Array ? input : input.bytes
      const mode = input instanceof Uint8Array ? 0o644 : input.mode
      contentBytes += body.length
      if (contentBytes > MAX_TAR_UNCOMPRESSED_BYTES) {
        throw new Error(`Tar archive exceeds ${MAX_TAR_UNCOMPRESSED_BYTES} uncompressed bytes`)
      }
      return {
        header: {
          name: archivePath,
          size: body.length,
          type: 'file',
          mode: mode === 0o755 ? 0o755 : 0o644,
          mtime: new Date(0),
          uid: 0,
          gid: 0,
          uname: '',
          gname: '',
        },
        body,
      }
    })

  const archive = await packTar(entries)
  if (archive.length > MAX_TAR_UNCOMPRESSED_BYTES) {
    throw new Error(`Tar archive exceeds ${MAX_TAR_UNCOMPRESSED_BYTES} uncompressed bytes`)
  }
  return archive
}

export async function gzip(data: Uint8Array): Promise<Uint8Array> {
  const input = new Blob([data.slice().buffer as ArrayBuffer]).stream()
  const compressed = new Uint8Array(await new Response(input.pipeThrough(createGzipEncoder())).arrayBuffer())
  if (compressed.length < gzipMinimumLength
    || compressed[0] !== 0x1f || compressed[1] !== 0x8b || compressed[2] !== 0x08
    || compressed[3] !== 0) {
    throw new Error('Gzip encoder returned an unsupported member header')
  }
  // CompressionStream delegates to the host runtime, which records its OS in
  // the otherwise non-semantic gzip header. Normalize those metadata bytes so
  // digest-addressed archives are reproducible across supported runtimes.
  compressed.fill(0, 4, 9)
  compressed[9] = 0xff
  return compressed
}
