import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, utimes } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { acquireProcessLock } from './process-lock'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

describe('Registry refresh process lock', () => {
  test('rejects overlap and reclaims a stale owner', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'registry-process-lock-'))
    roots.push(root)
    const lockPath = path.join(root, 'refresh.lock')
    const release = await acquireProcessLock(lockPath, { staleMs: 10_000, heartbeatMs: 1_000 })
    await expect(acquireProcessLock(lockPath, { staleMs: 10_000 })).rejects.toThrow('already running')
    await release()

    await mkdir(lockPath)
    const stale = new Date(Date.now() - 20_000)
    await utimes(lockPath, stale, stale)
    const releaseReclaimed = await acquireProcessLock(lockPath, { staleMs: 10_000, heartbeatMs: 1_000 })
    await releaseReclaimed()
  })
})
