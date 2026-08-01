import {
  MAX_SKILL_ARTIFACT_COMPRESSED_BYTES,
} from '../types'
import { createTar, gzip, MEMOH_DIRECT_OWNER_PATH } from '#lib/archive'
import { sha256 } from '../digest'
import type { SkillSourceFile } from '../filesystem'

export async function packageSkill(files: Record<string, SkillSourceFile>) {
  // Artifact bytes describe only the Skill content. The Catalog's install_id
  // selects the destination namespace and must not influence the content hash.
  const bytes = await gzip(await createTar(files, '', {
    reservedRootPaths: [MEMOH_DIRECT_OWNER_PATH],
  }))
  if (bytes.length > MAX_SKILL_ARTIFACT_COMPRESSED_BYTES) {
    throw new Error(`Compressed Skill Artifact exceeds ${MAX_SKILL_ARTIFACT_COMPRESSED_BYTES} bytes`)
  }
  return { bytes, digest: await sha256(bytes) }
}
