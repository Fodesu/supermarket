import { acquireProcessLock } from './process-lock'

export async function acquireRegistryWriterLock(processLockPath: string) {
  const releaseProcessLock = await acquireProcessLock(processLockPath)
  return {
    assertActive() {
      releaseProcessLock.assertActive()
    },
    release: releaseProcessLock,
  }
}
