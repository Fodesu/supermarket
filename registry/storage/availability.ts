import { sha256 } from '../digest'
import type { SkillRegistryStore } from './contracts'

export interface SkillArtifactReference {
  digest: string
  size: number
}

async function consume(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader()
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return size
      size += value.length
    }
  } finally {
    reader.releaseLock()
  }
}

export async function assertSkillArtifactsAvailable(
  store: SkillRegistryStore,
  references: Iterable<SkillArtifactReference>,
  label = 'Skill Artifact',
) {
  const expected = new Map<string, number>()
  for (const reference of references) {
    const previous = expected.get(reference.digest)
    if (previous != null && previous !== reference.size) {
      throw new Error(`${label} ${reference.digest} has conflicting expected sizes`)
    }
    expected.set(reference.digest, reference.size)
  }

  for (const [digest, size] of expected) {
    try {
      if (store.getArtifactStream) {
        const streamed = await store.getArtifactStream(digest)
        if (!streamed) throw new Error(`${label} is missing: ${digest}`)
        if (streamed.descriptor.format !== 'memoh_skill_v1'
          || streamed.descriptor.content_type !== 'application/gzip'
          || streamed.descriptor.digest !== digest
          || streamed.descriptor.size !== size) {
          if (streamed.body instanceof ReadableStream) await streamed.body.cancel()
          throw new Error(`${label} does not match its descriptor: ${digest}`)
        }
        const actualSize = streamed.body instanceof Uint8Array
          ? streamed.body.length
          : await consume(streamed.body)
        if (actualSize !== size
          || (streamed.body instanceof Uint8Array && await sha256(streamed.body) !== digest)) {
          throw new Error(`${label} content is corrupt: ${digest}`)
        }
        continue
      }

      const artifact = await store.getArtifact(digest)
      if (!artifact) throw new Error(`${label} is missing: ${digest}`)
      if (artifact.descriptor.format !== 'memoh_skill_v1'
        || artifact.descriptor.content_type !== 'application/gzip'
        || artifact.descriptor.digest !== digest
        || artifact.descriptor.size !== size
        || artifact.bytes.length !== size
        || await sha256(artifact.bytes) !== digest) {
        throw new Error(`${label} content is corrupt: ${digest}`)
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(label)) throw error
      throw new Error(`${label} content is corrupt: ${digest}`, { cause: error })
    }
  }
}
