import { describe, expect, test } from 'bun:test'
import { resolveArtifactDownloadURL } from './protocol'

describe('Skill Registry client protocol', () => {
  test('accepts Supermarket Artifact paths and rejects cross-origin downloads', () => {
    expect(resolveArtifactDownloadURL('/api/artifacts/abc/download', 'https://supermarket.memoh.ai'))
      .toBe('https://supermarket.memoh.ai/api/artifacts/abc/download')
    expect(resolveArtifactDownloadURL('https://supermarket.memoh.ai/api/artifacts/abc/download', 'https://supermarket.memoh.ai'))
      .toBe('https://supermarket.memoh.ai/api/artifacts/abc/download')
    expect(() => resolveArtifactDownloadURL('https://github.com/example/archive.tar.gz', 'https://supermarket.memoh.ai'))
      .toThrow('Supermarket origin')
  })
})
