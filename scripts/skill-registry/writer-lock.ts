import type { SkillRegistryStore } from '../../server/utils/skill-registry-store'
import { acquireProcessLock } from './process-lock'

export async function acquireRegistryWriterLock(
  store: SkillRegistryStore,
  processLockPath: string,
  holder: string,
) {
  const releaseProcessLock = await acquireProcessLock(processLockPath)
  let lease: Awaited<ReturnType<NonNullable<SkillRegistryStore['acquireWriterLease']>>> | undefined
  try {
    if (process.env.R2_ACCOUNT_ID) {
      if (!store.acquireWriterLease) throw new Error('Configured R2 Store does not support writer leases')
      lease = await store.acquireWriterLease({
        leaseMs: Number(process.env.REGISTRY_WRITER_LEASE_MS || 15 * 60 * 1000),
        heartbeatMs: process.env.REGISTRY_WRITER_LEASE_HEARTBEAT_MS
          ? Number(process.env.REGISTRY_WRITER_LEASE_HEARTBEAT_MS)
          : undefined,
        holder,
      })
    }
  } catch (error) {
    await releaseProcessLock()
    throw error
  }

  return {
    owner: lease?.owner,
    abandon() {
      lease?.abandon()
      lease = undefined
    },
    assertActive() {
      releaseProcessLock.assertActive()
      lease?.assertActive()
    },
    async release() {
      try {
        await lease?.release()
      } finally {
        await releaseProcessLock()
      }
    },
  }
}
