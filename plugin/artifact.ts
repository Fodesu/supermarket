import { stringify as stringifyYaml } from 'yaml'
import { createTar, gzip, type TarFileInput } from '#lib/archive'
import { sha256 } from '#registry/digest'
import { PluginBundleBudget } from './bundle'
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
  const budget = new PluginBundleBudget()
  for (const [name, input] of Object.entries(files)) {
    budget.add(name, input instanceof Uint8Array ? input.length : input.bytes.length)
  }
  const bytes = await gzip(await createTar(files, plugin.id))
  const descriptor: PluginArtifactDescriptor = {
    format: 'memoh_plugin_v1',
    digest: await sha256(bytes),
    size: bytes.length,
    content_type: 'application/gzip',
  }
  return { descriptor, bytes }
}
