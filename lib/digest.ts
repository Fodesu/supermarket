export function assertDigest(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid artifact digest: ${value}`)
  return value
}
