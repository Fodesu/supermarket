export const MAX_PLUGIN_BUNDLE_FILES = 1_000
export const MAX_PLUGIN_BUNDLE_FILE_BYTES = 2 * 1024 * 1024
export const MAX_PLUGIN_BUNDLE_UNCOMPRESSED_BYTES = 10 * 1024 * 1024
export const MAX_PLUGIN_ARCHIVE_BYTES = 16 * 1024 * 1024
export const MAX_PLUGIN_ARTIFACT_COMPRESSED_BYTES = 6 * 1024 * 1024

export class PluginBundleBudget {
  private fileCount = 0
  private totalBytes = 0

  add(path: string, size: number) {
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Invalid Plugin file size: ${path}`)
    if (this.fileCount >= MAX_PLUGIN_BUNDLE_FILES) {
      throw new Error(`Plugin bundle exceeds ${MAX_PLUGIN_BUNDLE_FILES} files`)
    }
    if (size > MAX_PLUGIN_BUNDLE_FILE_BYTES) {
      throw new Error(`Plugin bundle file exceeds ${MAX_PLUGIN_BUNDLE_FILE_BYTES} bytes: ${path}`)
    }
    if (size > MAX_PLUGIN_BUNDLE_UNCOMPRESSED_BYTES - this.totalBytes) {
      throw new Error(`Plugin bundle exceeds ${MAX_PLUGIN_BUNDLE_UNCOMPRESSED_BYTES} bytes`)
    }
    this.fileCount++
    this.totalBytes += size
  }
}
