import path from 'node:path'
import { assertIdentifier } from '#registry/definition'
import {
  loadDigestLock,
  parseDigestLock,
  serializeDigestLock,
  writeDigestLock,
} from '#lib/release-lock'

export interface PluginReleaseLock {
  release_revision: string
}

export function pluginReleaseLockPath(projectRoot: string, pluginID: string) {
  return path.join(
    projectRoot,
    'registries',
    'memoh',
    'plugins',
    assertIdentifier(pluginID, 'plugin ID'),
    'release.lock.json',
  )
}

export function serializePluginReleaseLock(lock: PluginReleaseLock): Uint8Array {
  return serializeDigestLock(lock)
}

export function parsePluginReleaseLock(bytes: Uint8Array, pluginID: string): PluginReleaseLock {
  return parseDigestLock(bytes, 'release_revision', `${pluginID}: release.lock.json`)
}

export async function loadPluginReleaseLock(projectRoot: string, pluginID: string) {
  return loadDigestLock(
    pluginReleaseLockPath(projectRoot, pluginID),
    'release_revision',
    `${pluginID}: release.lock.json`,
  )
}

export async function writePluginReleaseLock(
  projectRoot: string,
  pluginID: string,
  lock: PluginReleaseLock,
) {
  await writeDigestLock(
    pluginReleaseLockPath(projectRoot, pluginID),
    'release_revision',
    `${pluginID}: release.lock.json`,
    lock,
  )
}

export function assertPluginReleaseCandidate(
  pluginID: string,
  lock: PluginReleaseLock,
  revision: string,
) {
  if (lock.release_revision !== revision) {
    throw new Error(
      `${pluginID}: release.lock.json locks Plugin release ${lock.release_revision}, `
      + `but the rebuilt release is ${revision}`,
    )
  }
}
