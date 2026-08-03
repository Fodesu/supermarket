import { stringify as stringifyYaml } from 'yaml'
import { createTar, gzip, type TarFileInput } from '#lib/archive'
import { sha256 } from '#lib/digest'
import {
  MAX_PLUGIN_ARCHIVE_BYTES,
  MAX_PLUGIN_ARTIFACT_COMPRESSED_BYTES,
  MAX_PLUGIN_BUNDLE_UNCOMPRESSED_BYTES,
} from './bundle'
import type { CommittedPlugin } from './repository'
import type { PluginArtifactDescriptor } from './types'

export interface PackagedPlugin {
  descriptor: PluginArtifactDescriptor
  bytes: Uint8Array
}

export async function packagePlugin(plugin: CommittedPlugin): Promise<PackagedPlugin> {
  const manifest = new TextEncoder().encode(stringifyYaml(plugin.manifest))
  const files: Record<string, Uint8Array | TarFileInput> = {
    ...plugin.files,
    'plugin.yaml': manifest,
  }
  const bytes = await gzip(await createTar(files, plugin.id, {
    maxContentBytes: MAX_PLUGIN_BUNDLE_UNCOMPRESSED_BYTES,
    maxArchiveBytes: MAX_PLUGIN_ARCHIVE_BYTES,
  }))
  if (bytes.length > MAX_PLUGIN_ARTIFACT_COMPRESSED_BYTES) {
    throw new Error(`Compressed Plugin Artifact exceeds ${MAX_PLUGIN_ARTIFACT_COMPRESSED_BYTES} bytes`)
  }
  const descriptor: PluginArtifactDescriptor = {
    format: 'memoh_plugin_v1',
    digest: await sha256(bytes),
    size: bytes.length,
    content_type: 'application/gzip',
  }
  return { descriptor, bytes }
}
