import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
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
    release.assertActive()
    await expect(acquireProcessLock(lockPath, { staleMs: 10_000 })).rejects.toThrow('already running')
    const staleWhileOwned = new Date(Date.now() - 20_000)
    await utimes(lockPath, staleWhileOwned, staleWhileOwned)
    await expect(acquireProcessLock(lockPath, { staleMs: 10_000 })).rejects.toThrow('owner may still be running')
    await release()

    await mkdir(lockPath)
    await writeFile(path.join(lockPath, 'owner.json'), JSON.stringify({
      pid: 99_999_999, host: os.hostname(), token: crypto.randomUUID(),
    }))
    const stale = new Date(Date.now() - 20_000)
    await utimes(lockPath, stale, stale)
    const releaseReclaimed = await acquireProcessLock(lockPath, { staleMs: 10_000, heartbeatMs: 1_000 })
    await releaseReclaimed()

    await mkdir(lockPath)
    await utimes(lockPath, stale, stale)
    await expect(acquireProcessLock(lockPath, { staleMs: 10_000 })).rejects.toThrow('remove it manually')
  })

  test('does not heartbeat or delete a replacement owner lock', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'registry-process-lock-owner-'))
    roots.push(root)
    const lockPath = path.join(root, 'refresh.lock')
    const release = await acquireProcessLock(lockPath, { staleMs: 10_000, heartbeatMs: 1_000 })
    await writeFile(path.join(lockPath, 'owner.json'), JSON.stringify({
      pid: process.pid, host: os.hostname(), token: crypto.randomUUID(),
    }))
    await expect(release()).rejects.toThrow('ownership was lost')
    expect((await stat(lockPath)).isDirectory()).toBe(true)
  })
})
