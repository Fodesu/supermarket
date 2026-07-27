import { readFile } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const shared = JSON.parse(await readFile(path.join(root, 'registry-deployment.json'), 'utf8')) as { r2_bucket?: unknown }
if (typeof shared.r2_bucket !== 'string' || !shared.r2_bucket) throw new Error('registry-deployment.json must define r2_bucket')

const writerConfig = await readFile(path.join(root, 'writer.wrangler.jsonc'), 'utf8')
const match = writerConfig.match(/"binding"\s*:\s*"SKILL_REGISTRY_BUCKET"\s*,\s*"bucket_name"\s*:\s*"([^"]+)"/s)
if (!match || match[1] !== shared.r2_bucket) {
  throw new Error(`Writer R2 binding must match registry-deployment.json (${shared.r2_bucket})`)
}

if (process.env.R2_BUCKET && process.env.R2_BUCKET !== shared.r2_bucket) {
  throw new Error(`R2_BUCKET (${process.env.R2_BUCKET}) must match registry-deployment.json (${shared.r2_bucket})`)
}

console.log(`Registry bucket verified: ${shared.r2_bucket}`)
