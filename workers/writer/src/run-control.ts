export interface KillableExecProcess {
  output(): Promise<{ stdout: ArrayBuffer; stderr: ArrayBuffer; exitCode: number }>
  kill(signal?: number): void
}

export class SingleFlight<T> {
  private active: Promise<T> | undefined

  run(operation: () => Promise<T>): Promise<T> {
    if (this.active) return this.active
    const active = operation()
    this.active = active
    return active.finally(() => {
      if (this.active === active) this.active = undefined
    })
  }
}

export async function processOutputWithTimeout(
  process: KillableExecProcess,
  timeoutMs: number,
) {
  let timedOut = false
  const terminate = setTimeout(() => {
    timedOut = true
    process.kill(15)
  }, timeoutMs)
  const forceKill = setTimeout(() => {
    if (timedOut) process.kill(9)
  }, timeoutMs + 5_000)
  try {
    const output = await process.output()
    if (timedOut) throw new Error(`Registry refresh exceeded its ${timeoutMs}ms execution limit`)
    return output
  } finally {
    clearTimeout(terminate)
    clearTimeout(forceKill)
  }
}

export function startRunHeartbeat(
  renew: () => Promise<boolean>,
  onLost: (error: Error) => void,
  intervalMs: number,
) {
  let work = Promise.resolve()
  let stopped = false
  const timer = setInterval(() => {
    work = work.then(async () => {
      if (stopped) return
      if (!await renew()) throw new Error('Registry writer lost its active run')
    }).catch((error) => {
      stopped = true
      onLost(error instanceof Error ? error : new Error(String(error)))
    })
  }, intervalMs)
  return async () => {
    stopped = true
    clearInterval(timer)
    await work
  }
}
