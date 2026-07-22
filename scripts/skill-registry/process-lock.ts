import { mkdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'

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
      await writeFile(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }))
      const heartbeat = setInterval(() => {
        const now = new Date()
        void utimes(lockPath, now, now).catch(() => {})
      }, heartbeatMs)
      heartbeat.unref()
      let released = false
      return async () => {
        if (released) return
        released = true
        clearInterval(heartbeat)
        await rm(lockPath, { recursive: true, force: true })
      }
    } catch (error) {
      if (ownsLock) {
        await rm(lockPath, { recursive: true, force: true })
        throw error
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const observed = await stat(lockPath).catch(() => null)
      if (!observed) continue
      if (Date.now() - observed.mtimeMs <= staleMs) throw new Error(`Registry refresh is already running: ${lockPath}`)
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
