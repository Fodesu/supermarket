import { createGzipEncoder, packTar, type TarEntry } from 'modern-tar'

export const MAX_TAR_UNCOMPRESSED_BYTES = 100 * 1024 * 1024

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
    .sort(([left], [right]) => left.localeCompare(right))
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
  return new Uint8Array(await new Response(input.pipeThrough(createGzipEncoder())).arrayBuffer())
}
