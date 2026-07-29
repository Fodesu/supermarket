import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { checkRegistryDeploymentConfig } from './check-config'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

async function writeConfigs(apiBucket: string, writerBucket: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'registry-worker-config-'))
  roots.push(root)
  await mkdir(path.join(root, 'workers/api'), { recursive: true })
  await mkdir(path.join(root, 'workers/writer'), { recursive: true })
  const environment = (bucket: string, production = false) => ({
    r2_buckets: [{ binding: 'SKILL_REGISTRY_BUCKET', bucket_name: bucket }],
    version_metadata: { binding: 'WORKER_VERSION' },
    ...(production ? { triggers: { crons: ['*/15 * * * *'] } } : {}),
  })
  await writeFile(path.join(root, 'workers/api/wrangler.jsonc'), JSON.stringify({
    env: { test: environment(apiBucket), production: environment(apiBucket) },
  }))
  await writeFile(path.join(root, 'workers/writer/wrangler.jsonc'), JSON.stringify({
    env: { test: environment(writerBucket), production: environment(writerBucket, true) },
  }))
  return root
}

describe('Registry Worker deployment configuration', () => {
  test('keeps API and Writer on the same bucket per environment', async () => {
    await expect(checkRegistryDeploymentConfig(path.resolve(import.meta.dirname, '../..'))).resolves.toBeUndefined()
    await expect(checkRegistryDeploymentConfig(await writeConfigs('shared', 'shared'))).resolves.toBeUndefined()
    await expect(checkRegistryDeploymentConfig(await writeConfigs('api', 'writer'))).rejects.toThrow('bucket mismatch')
  })
})
