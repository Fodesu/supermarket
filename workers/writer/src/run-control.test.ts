import { describe, expect, test } from 'bun:test'
import { processOutputWithTimeout, SingleFlight, startRunHeartbeat } from './run-control'

describe('Writer run control', () => {
  test('coalesces concurrent scheduled refreshes', async () => {
    const flight = new SingleFlight<number>()
    let starts = 0
    let finish!: (value: number) => void
    const operation = () => {
      starts++
      return new Promise<number>((resolve) => {
        finish = resolve
      })
    }
    const first = flight.run(operation)
    const second = flight.run(operation)
    expect(starts).toBe(1)
    finish(42)
    expect(await Promise.all([first, second])).toEqual([42, 42])
  })

  test('terminates a Container process after the execution limit', async () => {
    let resolve!: (value: { stdout: ArrayBuffer; stderr: ArrayBuffer; exitCode: number }) => void
    const signals: number[] = []
    const process = {
      output: () => new Promise<{ stdout: ArrayBuffer; stderr: ArrayBuffer; exitCode: number }>((done) => {
        resolve = done
      }),
      kill(signal = 15) {
        signals.push(signal)
        resolve({ stdout: new ArrayBuffer(0), stderr: new ArrayBuffer(0), exitCode: 143 })
      },
    }
    await expect(processOutputWithTimeout(process, 5)).rejects.toThrow('execution limit')
    expect(signals).toEqual([15])
  })

  test('reports a lost heartbeat and stops renewing', async () => {
    let renewals = 0
    let failure: Error | undefined
    const stop = startRunHeartbeat(async () => ++renewals < 2, (error) => {
      failure = error
    }, 2)
    await Bun.sleep(15)
    await stop()
    expect(renewals).toBe(2)
    expect(failure?.message).toContain('lost its active run')
  })
})
