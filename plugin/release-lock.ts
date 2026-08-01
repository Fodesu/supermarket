import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { assertIdentifier } from '#registry/definition'
import { assertDigest } from '#registry/storage/validation'

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
  return new TextEncoder().encode(`${JSON.stringify(lock, null, 2)}\n`)
}

export function parsePluginReleaseLock(bytes: Uint8Array, pluginID: string): PluginReleaseLock {
  const label = `${pluginID}: release.lock.json`
  let lock: PluginReleaseLock
  try {
    lock = JSON.parse(new TextDecoder().decode(bytes)) as PluginReleaseLock
  } catch {
    throw new Error(`${label} must contain valid JSON`)
  }
  try {
    if (!lock || typeof lock !== 'object' || Array.isArray(lock)
      || Object.keys(lock).length !== 1 || !Object.hasOwn(lock, 'release_revision')
      || typeof lock.release_revision !== 'string') {
      throw new Error('invalid release lock shape')
    }
    assertDigest(lock.release_revision)
  } catch {
    throw new Error(`${label} must contain a valid release_revision`)
  }
  const canonical = serializePluginReleaseLock(lock)
  if (canonical.length !== bytes.length || !canonical.every((value, index) => value === bytes[index])) {
    throw new Error(`${label} must use canonical JSON formatting`)
  }
  return lock
}

export async function loadPluginReleaseLock(projectRoot: string, pluginID: string) {
  const file = pluginReleaseLockPath(projectRoot, pluginID)
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await readFile(file))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`${pluginID}: release.lock.json is required`)
    throw error
  }
  return parsePluginReleaseLock(bytes, pluginID)
}

export async function writePluginReleaseLock(
  projectRoot: string,
  pluginID: string,
  lock: PluginReleaseLock,
) {
  const bytes = serializePluginReleaseLock(lock)
  parsePluginReleaseLock(bytes, pluginID)
  await writeFile(pluginReleaseLockPath(projectRoot, pluginID), bytes)
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
