import path from 'node:path'
import { z } from 'zod'
import { skillInstallID } from '#registry/definition'
import { MAX_SKILL_ARTIFACT_COMPRESSED_BYTES } from '#registry/types'
import { extractSkillArchive, parseGzipTarArchive, validateSkillArchive } from './archive'
import {
  MAX_REGISTRY_JSON_BYTES,
  readBoundedResponse,
  REGISTRY_REQUEST_TIMEOUT_MS,
  resolveArtifactDownloadURL,
  responseError,
} from './protocol'

function option(name: string) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function json(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: 'application/json' }, redirect: 'error',
    signal: AbortSignal.timeout(REGISTRY_REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw await responseError(response)
  return JSON.parse(new TextDecoder().decode(await readBoundedResponse(response, MAX_REGISTRY_JSON_BYTES, 'Registry response')))
}

interface InstallableSkillResponse {
  registry_id: string
  package_id: string
  skill_id: string
  install_id: string
  artifact: {
    format: 'memoh_skill_v1'
    digest: string
    size: number
    download_url: string
  }
}

const installableSkillSchema = z.object({
  registry_id: z.string(),
  package_id: z.string(),
  skill_id: z.string(),
  install_id: z.string(),
  artifact: z.object({
    format: z.literal('memoh_skill_v1'),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().min(0).max(MAX_SKILL_ARTIFACT_COMPRESSED_BYTES),
    download_url: z.string(),
  }),
})

function installableSkillResponse(value: unknown): InstallableSkillResponse {
  const result = installableSkillSchema.safeParse(value)
  if (!result.success) throw new Error('Invalid Skill response')
  const { registry_id, package_id, skill_id, install_id, artifact } = result.data
  return {
    registry_id, package_id, skill_id, install_id,
    artifact: {
      format: artifact.format,
      digest: artifact.digest,
      size: artifact.size,
      download_url: artifact.download_url,
    },
  }
}

async function download(url: string) {
  const response = await fetch(url, {
    redirect: 'error', signal: AbortSignal.timeout(REGISTRY_REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw await responseError(response)
  return readBoundedResponse(response, MAX_SKILL_ARTIFACT_COMPRESSED_BYTES, 'Artifact')
}

async function digest(bytes: Uint8Array) {
  const hash = await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer)
  return [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

const command = process.argv[2]
const base = (option('--base') ?? process.env.SUPERMARKET_URL ?? 'http://127.0.0.1:5173').replace(/\/$/, '')
const positional = process.argv.slice(3).filter((value, index, values) => !value.startsWith('--') && values[index - 1]?.startsWith('--') !== true)

switch (command) {
  case 'list': {
    console.log(JSON.stringify(await json(`${base}/api/registries`), null, 2))
    break
  }
  case 'search': {
    const query = new URLSearchParams()
    if (positional[0]) query.set('q', positional[0])
    for (const name of ['registry', 'package', 'category', 'tag', 'os', 'page', 'limit', 'sort']) {
      const value = option(`--${name}`)
      if (value) query.set(name, value)
    }
    console.log(JSON.stringify(await json(`${base}/api/skills?${query}`), null, 2))
    break
  }
  case 'inspect':
  case 'install': {
    const [registryID, packageID, skillID] = positional
    if (!registryID || !packageID || !skillID) throw new Error(`${command} requires <registry> <package> <skill>`)
    const response = await json(`${base}/api/registries/${encodeURIComponent(registryID)}/packages/${encodeURIComponent(packageID)}/skills/${encodeURIComponent(skillID)}`)
    if (command === 'inspect') {
      console.log(JSON.stringify(response, null, 2))
      break
    }
    const skill = installableSkillResponse(response)
    const artifact = skill.artifact
    const installID = skillInstallID(registryID, packageID, skillID)
    if (
      skill.registry_id !== registryID || skill.package_id !== packageID || skill.skill_id !== skillID
      || skill.install_id !== installID
    ) {
      throw new Error('Artifact descriptor does not match the requested Skill')
    }
    const bytes = await download(resolveArtifactDownloadURL(artifact.download_url, base))
    if (bytes.length !== artifact.size) throw new Error(`Artifact size mismatch: expected ${artifact.size}, got ${bytes.length}`)
    const actualDigest = await digest(bytes)
    if (actualDigest !== artifact.digest) throw new Error(`SHA-256 mismatch: expected ${artifact.digest}, got ${actualDigest}`)
    const files = await parseGzipTarArchive(bytes)
    validateSkillArchive(files)
    const destination = path.resolve(option('--destination') ?? '.data/registry-client-installs')
    console.log(JSON.stringify({ installed_at: await extractSkillArchive(files, destination, installID), digest: actualDigest }, null, 2))
    break
  }
  default:
    throw new Error('Usage: registry:client <list|search|inspect|install> [arguments] [--base URL]')
}
