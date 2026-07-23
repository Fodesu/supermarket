import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { SkillRegistryStore } from '../../server/utils/skill-registry-store'
import { acquireRegistryWriterLock } from './writer-lock'

const roots: string[] = []
const originalAccountID = process.env.R2_ACCOUNT_ID
afterEach(async () => {
  if (originalAccountID == null) delete process.env.R2_ACCOUNT_ID
  else process.env.R2_ACCOUNT_ID = originalAccountID
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Registry writer lock', () => {
  test('combines the local process lock with the R2 writer lease and releases both', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'registry-writer-lock-'))
    roots.push(root)
    const processLockPath = path.join(root, 'writer.lock')
    let assertions = 0
    let abandons = 0
    let releases = 0
    process.env.R2_ACCOUNT_ID = 'test-account'
    const store = {
      acquireWriterLease: async () => ({
        owner: '00000000-0000-4000-8000-000000000000',
        assertActive: () => { assertions++ },
        abandon: () => { abandons++ },
        release: async () => { releases++ },
      }),
    } as SkillRegistryStore

    const first = await acquireRegistryWriterLock(store, processLockPath, 'test')
    first.assertActive()
    expect(assertions).toBe(1)
    await first.release()
    expect(releases).toBe(1)

    delete process.env.R2_ACCOUNT_ID
    const second = await acquireRegistryWriterLock(store, processLockPath, 'local-test')
    second.assertActive()
    await second.release()
    expect(releases).toBe(1)

    process.env.R2_ACCOUNT_ID = 'test-account'
    const abandoned = await acquireRegistryWriterLock(store, processLockPath, 'abandoned-test')
    expect(abandoned.owner).toBe('00000000-0000-4000-8000-000000000000')
    abandoned.abandon()
    await abandoned.release()
    expect(abandons).toBe(1)
    expect(releases).toBe(1)
  })
})
