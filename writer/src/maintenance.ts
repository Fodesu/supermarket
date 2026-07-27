export const registryGcIntervalMs = 24 * 60 * 60 * 1000

export function isRegistryGcDue(lastRunAt: string | undefined, now = Date.now()) {
  if (!lastRunAt) return true
  const lastRun = Date.parse(lastRunAt)
  return !Number.isFinite(lastRun) || now >= lastRun + registryGcIntervalMs
}
