import { afterEach, describe, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { acquireRegistryWriterLock } from './writer-lock'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Registry writer lock', () => {
  test('serializes local maintenance commands', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'registry-writer-lock-'))
    roots.push(root)
    const processLockPath = path.join(root, 'writer.lock')
    const first = await acquireRegistryWriterLock(processLockPath)
    first.assertActive()
    await first.release()

    const second = await acquireRegistryWriterLock(processLockPath)
    second.assertActive()
    await second.release()
  })
})
