const stateKeyPattern = /^skill-registries\/[^/]+\/state\.json$/
const snapshotKeyPattern = /^skill-registries\/[^/]+\/snapshots\/[a-f0-9]{64}\.json$/
const artifactKeyPattern = /^skill-artifacts\/[a-f0-9]{64}\.tar\.gz$/
const imageKeyPattern = /^skill-images\/[a-f0-9]{64}(?:\.json)?$/

export function objectKey(pathname: string) {
  if (!pathname.startsWith('/objects/')) return undefined
  const key = decodeURIComponent(pathname.slice('/objects/'.length))
  if (!key || key.includes('\0') || key.split('/').some((part) => part === '..')) return undefined
  return key
}

export function isRegistryStateKey(key: string) {
  return stateKeyPattern.test(key)
}

export function isImmutableRegistryKey(key: string) {
  return snapshotKeyPattern.test(key) || artifactKeyPattern.test(key) || imageKeyPattern.test(key)
}

export function isAllowedRegistryListPrefix(prefix: string) {
  return ['skill-registries/', 'skill-artifacts/', 'skill-images/'].includes(prefix)
}

export interface ActiveRegistryRun {
  token: string
  started_at: string
  expires_at: string
}

export function activeRegistryRun(value: unknown, now = Date.now()): ActiveRegistryRun | null {
  if (!value || typeof value !== 'object') return null
  const run = value as Record<string, unknown>
  if (typeof run.token !== 'string' || typeof run.started_at !== 'string' || typeof run.expires_at !== 'string') return null
  const expiresAt = Date.parse(run.expires_at)
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null
  return run as unknown as ActiveRegistryRun
}
