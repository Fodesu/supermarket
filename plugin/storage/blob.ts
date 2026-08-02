import { sha256 } from '#registry/digest'
import { assertIdentifier } from '#registry/definition'
import {
  type StreamingBlobBackend,
} from '#registry/storage/contracts'
import { putImmutableObject } from '#registry/storage/immutable'
import { VersionedJSONState } from '#registry/storage/versioned-state'
import { assertDigest, verifiedAssetStream } from '#registry/storage/validation'
import { MAX_PLUGIN_ARTIFACT_COMPRESSED_BYTES } from '../bundle'
import {
  assertPluginReleaseRevision,
  parsePluginRelease,
} from '../release'
import type {
  PluginArtifactDescriptor,
  PluginReleaseState,
} from '../types'
import type { PluginReleaseStateRead, PluginReleaseStore } from './contracts'

const MAX_PLUGIN_STATE_BYTES = 64 * 1024
const MAX_PLUGIN_RELEASE_BYTES = 2 * 1024 * 1024

function validateState(state: PluginReleaseState, pluginID: string) {
  if (!state || state.schema_version !== '1' || state.plugin_id !== pluginID
    || typeof state.enabled !== 'boolean') {
    throw new Error(`Invalid Plugin release state: ${pluginID}`)
  }
  if (!state.current_release) {
    if (state.current_summary) throw new Error(`Plugin state has a summary without a release: ${pluginID}`)
    return
  }
  assertDigest(state.current_release)
  const summary = state.current_summary
  if (!summary || summary.revision !== state.current_release || !summary.name || !summary.version
    || !Number.isFinite(Date.parse(summary.published_at))) {
    throw new Error(`Plugin state has an invalid current summary: ${pluginID}`)
  }
}

function validateArtifact(descriptor: PluginArtifactDescriptor, digest: string) {
  if (descriptor.format !== 'memoh_plugin_v1' || descriptor.content_type !== 'application/gzip'
    || descriptor.digest !== assertDigest(digest) || !Number.isSafeInteger(descriptor.size)
    || descriptor.size < 1 || descriptor.size > MAX_PLUGIN_ARTIFACT_COMPRESSED_BYTES) {
    throw new Error(`Invalid Plugin Artifact metadata: ${digest}`)
  }
}

export class BlobPluginReleaseStore implements PluginReleaseStore {
  private readonly stateStore

  constructor(private readonly backend: StreamingBlobBackend) {
    this.stateStore = new VersionedJSONState(backend, {
      label: 'Plugin state',
      maxBytes: MAX_PLUGIN_STATE_BYTES,
      normalizeID: (id) => assertIdentifier(id, 'plugin ID'),
      stateID: (state: PluginReleaseState) => state.plugin_id,
      key: (id) => `plugin-releases/${id}/state.json`,
      validate: validateState,
    })
  }

  async listPluginIDs() {
    const prefixes = await this.backend.listPrefixes('plugin-releases/')
    return [...new Set(prefixes.flatMap((prefix): string[] => {
      const match = prefix.match(/^plugin-releases\/([^/]+)\/$/)
      return match?.[1] ? [match[1]] : []
    }))].sort()
  }

  async getState(pluginID: string) {
    return (await this.getStateWithVersion(pluginID)).state
  }

  async getStateWithVersion(pluginID: string): Promise<PluginReleaseStateRead> {
    return this.stateStore.get(pluginID)
  }

  async putState(state: PluginReleaseState, expectedVersion?: string | null) {
    await this.stateStore.put(state, expectedVersion)
  }

  private async readReleaseBytes(pluginID: string, revision: string) {
    const id = assertIdentifier(pluginID, 'plugin ID')
    const digest = assertDigest(revision)
    const key = `plugin-releases/${id}/releases/${digest}.json`
    const bytes = await this.backend.get(key)
    if (!bytes) return null
    if (bytes.length > MAX_PLUGIN_RELEASE_BYTES) throw new Error(`Stored Plugin release exceeds ${MAX_PLUGIN_RELEASE_BYTES} bytes: ${key}`)
    await assertPluginReleaseRevision(bytes, digest)
    return bytes
  }

  async getReleaseBytes(pluginID: string, revision: string) {
    return this.readReleaseBytes(pluginID, revision)
  }

  async getRelease(pluginID: string, revision: string) {
    const bytes = await this.readReleaseBytes(pluginID, revision)
    return bytes ? parsePluginRelease(bytes, pluginID) : null
  }

  async publishRelease(
    bytes: Uint8Array,
    pluginID: string,
    options: { expectedVersion?: string | null; expectedRevision?: string; publishedAt?: string } = {},
  ) {
    const id = assertIdentifier(pluginID, 'plugin ID')
    if (bytes.length > MAX_PLUGIN_RELEASE_BYTES) throw new Error(`Plugin release exceeds ${MAX_PLUGIN_RELEASE_BYTES} bytes: ${id}`)
    const release = parsePluginRelease(bytes, id)
    const revision = await sha256(bytes)
    if (options.expectedRevision && revision !== assertDigest(options.expectedRevision)) {
      throw new Error(`${id}: Plugin release does not match approved revision ${options.expectedRevision}`)
    }
    await putImmutableObject(
      this.backend,
      `plugin-releases/${id}/releases/${revision}.json`,
      bytes,
      'Plugin release',
    )
    const publishedAt = options.publishedAt ?? new Date().toISOString()
    if (!Number.isFinite(Date.parse(publishedAt))) throw new Error(`Invalid Plugin publication time: ${publishedAt}`)
    await this.putState({
      schema_version: '1',
      plugin_id: id,
      enabled: true,
      current_release: revision,
      current_summary: {
        revision,
        published_at: publishedAt,
        name: release.plugin.name,
        version: release.plugin.version,
      },
    }, options.expectedVersion)
    return revision
  }

  async putArtifact(descriptor: PluginArtifactDescriptor, bytes: Uint8Array) {
    validateArtifact(descriptor, descriptor.digest)
    if (descriptor.size !== bytes.length || descriptor.digest !== await sha256(bytes)) {
      throw new Error('Plugin Artifact metadata does not match its content')
    }
    return {
      stored: await putImmutableObject(
        this.backend,
        `plugin-artifacts/${descriptor.digest}.tar.gz`,
        bytes,
        'Plugin Artifact',
      ),
    }
  }

  async getArtifactStream(digest: string) {
    const value = assertDigest(digest)
    const streamed = await this.backend.getStream(`plugin-artifacts/${value}.tar.gz`)
    if (!streamed) return null
    if (streamed.size == null) throw new Error(`Stored Plugin Artifact size is unavailable: ${value}`)
    const descriptor: PluginArtifactDescriptor = {
      format: 'memoh_plugin_v1', digest: value, size: streamed.size, content_type: 'application/gzip',
    }
    validateArtifact(descriptor, value)
    return { descriptor, body: verifiedAssetStream(streamed.body, descriptor, 'Plugin Artifact') }
  }
}
