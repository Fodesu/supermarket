import * as z from 'zod/mini'

const maxScheduledRegistryStateBytes = 256 * 1024
const stateReadConcurrency = 20

export type RefreshScheduleDecision =
  | { action: 'run' }
  | { action: 'inspect_state' }
  | { action: 'skip'; nextRefreshAt: number }

export function decideRegistryRefresh(input: {
  force: boolean
  workerVersion: string
  handledWorkerVersion?: string
  scheduledRefreshAt?: number
  now: number
}): RefreshScheduleDecision {
  if (input.force || input.handledWorkerVersion !== input.workerVersion) return { action: 'run' }
  if (input.scheduledRefreshAt === undefined) return { action: 'inspect_state' }
  return input.scheduledRefreshAt <= input.now
    ? { action: 'run' }
    : { action: 'skip', nextRefreshAt: input.scheduledRefreshAt }
}

const scheduledRegistryStateSchema = z.object({
  schema_version: z.literal('1'),
  definition: z.object({
    enabled: z.boolean(),
    refresh_interval_seconds: z.number().check(z.int(), z.positive()),
  }),
  status: z.object({
    last_success_at: z.optional(z.string()),
  }),
})

/**
 * Returns the earliest time an enabled Registry is due. `null` means that
 * there are no enabled Registries to schedule.
 */
export function nextRegistryRefreshAt(states: unknown[], now = Date.now()): number | null {
  let next: number | null = null
  for (const value of states) {
    const parsed = scheduledRegistryStateSchema.safeParse(value)
    if (!parsed.success) {
      throw new Error('Invalid Registry scheduling state', { cause: parsed.error })
    }
    const state = parsed.data
    if (!state.definition.enabled) continue
    const lastSuccess = state.status.last_success_at
      ? Date.parse(state.status.last_success_at)
      : Number.NaN
    if (!Number.isFinite(lastSuccess)) return now
    const dueAt = lastSuccess + state.definition.refresh_interval_seconds * 1000
    if (!Number.isSafeInteger(dueAt) || !Number.isFinite(new Date(dueAt).getTime())) {
      throw new Error('Registry refresh deadline is outside the supported time range')
    }
    next = next === null ? dueAt : Math.min(next, dueAt)
  }
  return next
}

export async function nextRegistryRefreshFromBucket(bucket: R2Bucket, now = Date.now()) {
  const states: unknown[] = []
  let cursor: string | undefined
  do {
    const page = await bucket.list({
      prefix: 'skill-registries/',
      delimiter: '/',
      cursor,
    })
    const keys = (page.delimitedPrefixes ?? []).flatMap((prefix) => {
      const match = prefix.match(/^skill-registries\/([^/]+)\/$/)
      return match ? [`${prefix}state.json`] : []
    })
    for (let offset = 0; offset < keys.length; offset += stateReadConcurrency) {
      const batch = await Promise.all(keys.slice(offset, offset + stateReadConcurrency).map(async (key) => {
        const object = await bucket.get(key)
        if (!object) throw new Error(`Registry state disappeared while scheduling: ${key}`)
        if (object.size > maxScheduledRegistryStateBytes) {
          throw new Error(`Registry state is too large to schedule: ${key}`)
        }
        return object.json<unknown>()
      }))
      states.push(...batch)
    }
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return nextRegistryRefreshAt(states, now)
}
