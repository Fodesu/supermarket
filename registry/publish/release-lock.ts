import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { assertRegistryID } from '../definition'
import { assertDigest } from '../storage/validation'
import type { SkillRegistryDefinition } from '../types'

export interface RegistryReleaseLock {
  snapshot_revision: string
}

export function releaseLockPath(projectRoot: string, registryID: string) {
  return path.join(
    projectRoot,
    'registries',
    assertRegistryID(registryID, 'registry ID'),
    'release.lock.json',
  )
}

export function serializeRegistryReleaseLock(lock: RegistryReleaseLock): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(lock, null, 2)}\n`)
}

export function parseRegistryReleaseLock(
  bytes: Uint8Array,
  definition: SkillRegistryDefinition,
): RegistryReleaseLock {
  const label = `${definition.id}: release.lock.json`
  let lock: RegistryReleaseLock
  try {
    lock = JSON.parse(new TextDecoder().decode(bytes)) as RegistryReleaseLock
  } catch {
    throw new Error(`${label} must contain valid JSON`)
  }
  try {
    if (!lock || typeof lock !== 'object' || Array.isArray(lock)
      || Object.keys(lock).length !== 1 || !Object.hasOwn(lock, 'snapshot_revision')
      || typeof lock.snapshot_revision !== 'string') {
      throw new Error('invalid release lock shape')
    }
    assertDigest(lock.snapshot_revision)
  } catch {
    throw new Error(`${label} must contain a valid snapshot_revision`)
  }
  const canonical = serializeRegistryReleaseLock(lock)
  if (canonical.length !== bytes.length || !canonical.every((value, index) => value === bytes[index])) {
    throw new Error(`${label} must use canonical JSON formatting`)
  }
  return lock
}

export async function loadRegistryReleaseLock(
  projectRoot: string,
  definition: SkillRegistryDefinition,
): Promise<RegistryReleaseLock> {
  const file = releaseLockPath(projectRoot, definition.id)
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await readFile(file))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${definition.id}: release.lock.json is required`)
    }
    throw error
  }
  return parseRegistryReleaseLock(bytes, definition)
}

export async function writeRegistryReleaseLock(
  projectRoot: string,
  definition: SkillRegistryDefinition,
  lock: RegistryReleaseLock,
) {
  const bytes = serializeRegistryReleaseLock(lock)
  parseRegistryReleaseLock(bytes, definition)
  await writeFile(releaseLockPath(projectRoot, definition.id), bytes)
}

export function assertReleaseCandidate(
  definition: SkillRegistryDefinition,
  lock: RegistryReleaseLock,
  revision: string,
) {
  if (lock.snapshot_revision !== revision) {
    throw new Error(
      `${definition.id}: release.lock.json locks Snapshot ${lock.snapshot_revision}, `
      + `but the rebuilt Snapshot is ${revision}`,
    )
  }
}
