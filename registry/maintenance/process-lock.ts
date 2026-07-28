import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

interface ProcessLockOwner { pid: number; host: string; token: string }

async function readOwner(lockPath: string): Promise<ProcessLockOwner | null> {
  try {
    const value = JSON.parse(await readFile(path.join(lockPath, 'owner.json'), 'utf8')) as Record<string, unknown>
    if (!Number.isSafeInteger(value.pid) || typeof value.host !== 'string' || typeof value.token !== 'string') return null
    return { pid: value.pid as number, host: value.host, token: value.token }
  } catch {
    return null
  }
}

function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export interface ProcessLockRelease {
  (): Promise<void>
  assertActive(): void
}

export async function acquireProcessLock(
  lockPath: string,
  options: { staleMs?: number; heartbeatMs?: number } = {},
) {
  const staleMs = options.staleMs ?? Number(process.env.REGISTRY_REFRESH_LOCK_STALE_MS || 15 * 60 * 1000)
  const heartbeatMs = options.heartbeatMs ?? Math.min(30_000, Math.max(1_000, Math.floor(staleMs / 3)))
  if (!Number.isFinite(staleMs) || staleMs < 10_000) throw new Error('Registry refresh lock stale interval must be at least 10000ms')
  await mkdir(path.dirname(lockPath), { recursive: true })
  for (let attempt = 0; attempt < 4; attempt++) {
    let ownsLock = false
    try {
      await mkdir(lockPath)
      ownsLock = true
      const token = crypto.randomUUID()
      await writeFile(path.join(lockPath, 'owner.json'), JSON.stringify({
        pid: process.pid, host: os.hostname(), token, created_at: new Date().toISOString(),
      }))
      let lost: Error | undefined
      let released = false
      let heartbeatWork = Promise.resolve()
      const updateHeartbeat = async () => {
        if (released || lost) return
        const owner = await readOwner(lockPath)
        if (owner?.token !== token) throw new Error(`Registry refresh process lock ownership was lost: ${lockPath}`)
        const now = new Date()
        await utimes(lockPath, now, now)
      }
      const heartbeat = setInterval(() => {
        heartbeatWork = heartbeatWork.then(updateHeartbeat).catch((error) => {
          lost = error instanceof Error ? error : new Error(String(error))
        })
      }, heartbeatMs)
      heartbeat.unref()
      const release = async () => {
        if (released) return
        released = true
        clearInterval(heartbeat)
        await heartbeatWork
        if (lost) throw lost
        const owner = await readOwner(lockPath)
        if (owner?.token !== token) throw new Error(`Registry refresh process lock ownership was lost: ${lockPath}`)
        await rm(lockPath, { recursive: true, force: true })
      }
      release.assertActive = () => {
        if (lost) throw lost
        if (released) throw new Error('Registry refresh process lock has been released')
      }
      return release as ProcessLockRelease
    } catch (error) {
      if (ownsLock) {
        await rm(lockPath, { recursive: true, force: true })
        throw error
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const observed = await stat(lockPath).catch(() => null)
      if (!observed) continue
      if (Date.now() - observed.mtimeMs <= staleMs) throw new Error(`Registry refresh is already running: ${lockPath}`)
      const owner = await readOwner(lockPath)
      if (!owner) {
        throw new Error(`Registry refresh lock is stale but has no valid owner metadata; inspect and remove it manually: ${lockPath}`)
      }
      if (owner.host !== os.hostname() || processIsAlive(owner.pid)) {
        throw new Error(`Registry refresh lock is stale but its owner may still be running: ${lockPath}`)
      }
      const current = await stat(lockPath).catch(() => null)
      if (!current || current.ino !== observed.ino || current.mtimeMs !== observed.mtimeMs) continue
      const stalePath = `${lockPath}.stale-${crypto.randomUUID()}`
      try {
        await rename(lockPath, stalePath)
      } catch (renameError) {
        if ((renameError as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw renameError
      }
      await rm(stalePath, { recursive: true, force: true })
    }
  }
  throw new Error(`Could not acquire Registry refresh lock: ${lockPath}`)
}
