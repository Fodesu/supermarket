import { readFile } from 'node:fs/promises'
import path from 'node:path'

interface WranglerEnvironment {
  r2_buckets?: Array<{ binding?: string; bucket_name?: string }>
  triggers?: { crons?: string[] }
}

interface WranglerConfig {
  env?: Record<string, WranglerEnvironment>
}

async function wranglerConfig(projectRoot: string, relativePath: string): Promise<WranglerConfig> {
  return Bun.JSONC.parse(await readFile(path.join(projectRoot, relativePath), 'utf8')) as WranglerConfig
}

function registryBucket(config: WranglerConfig, environment: string, configPath: string) {
  const buckets = config.env?.[environment]?.r2_buckets ?? []
  const binding = buckets.find((bucket) => bucket.binding === 'SKILL_REGISTRY_BUCKET')
  if (!binding?.bucket_name) {
    throw new Error(`${configPath} ${environment} is missing SKILL_REGISTRY_BUCKET`)
  }
  return binding.bucket_name
}

export async function checkRegistryDeploymentConfig(projectRoot: string) {
  const apiPath = 'workers/api/wrangler.jsonc'
  const writerPath = 'workers/writer/wrangler.jsonc'
  const [api, writer] = await Promise.all([
    wranglerConfig(projectRoot, apiPath),
    wranglerConfig(projectRoot, writerPath),
  ])
  for (const environment of ['test', 'production']) {
    const apiBucket = registryBucket(api, environment, apiPath)
    const writerBucket = registryBucket(writer, environment, writerPath)
    if (apiBucket !== writerBucket) {
      throw new Error(`${environment} bucket mismatch: API=${apiBucket}, Writer=${writerBucket}`)
    }
  }
  if (writer.env?.test?.triggers?.crons?.length) {
    throw new Error('The test Writer must not have a deployed cron')
  }
  if (!writer.env?.production?.triggers?.crons?.length) {
    throw new Error('The production Writer must declare a cron')
  }
}

if (import.meta.main) {
  await checkRegistryDeploymentConfig(path.resolve(import.meta.dirname, '../..'))
  console.log('Registry Worker deployment configuration is consistent.')
}
