export function resolveArtifactDownloadURL(value: unknown, base: string) {
  if (typeof value !== 'string' || !value) throw new Error('Artifact descriptor has no download URL')
  const baseURL = new URL(base)
  const artifactURL = new URL(value, baseURL)
  if (!['http:', 'https:'].includes(artifactURL.protocol) || artifactURL.origin !== baseURL.origin) {
    throw new Error('Artifact download URL must use the Supermarket origin')
  }
  return artifactURL.toString()
}
