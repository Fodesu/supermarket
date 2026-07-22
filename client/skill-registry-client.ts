import path from 'node:path'
import { extractSkillArchive, gunzip, parseTarArchive, validateSkillArchive } from './archive'

const maxCompressedBytes = 25 * 1024 * 1024

function option(name: string) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function json(url: string) {
  const response = await fetch(url, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`)
  return response.json()
}

async function download(url: string) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`)
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxCompressedBytes) throw new Error('Artifact exceeds compressed size limit')
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Artifact response has no body')
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > maxCompressedBytes) {
      await reader.cancel()
      throw new Error('Artifact exceeds compressed size limit')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
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
    console.log(JSON.stringify(await json(`${base}/api/catalog/skills?${query}`), null, 2))
    break
  }
  case 'inspect':
  case 'install': {
    const [registryID, packageID, skillID] = positional
    if (!registryID || !packageID || !skillID) throw new Error(`${command} requires <registry> <package> <skill>`)
    const skill: any = await json(`${base}/api/registries/${encodeURIComponent(registryID)}/packages/${encodeURIComponent(packageID)}/skills/${encodeURIComponent(skillID)}`)
    if (command === 'inspect') {
      console.log(JSON.stringify(skill, null, 2))
      break
    }
    const artifact = skill.artifact
    const bytes = await download(new URL(artifact.download_url, base).toString())
    const actualDigest = await digest(bytes)
    if (actualDigest !== artifact.digest) throw new Error(`SHA-256 mismatch: expected ${artifact.digest}, got ${actualDigest}`)
    const files = parseTarArchive(await gunzip(bytes))
    validateSkillArchive(files, skill.install_id)
    const destination = path.resolve(option('--destination') ?? '.data/registry-client-installs')
    console.log(JSON.stringify({ installed_at: await extractSkillArchive(files, destination, skill.install_id), digest: actualDigest }, null, 2))
    break
  }
  default:
    throw new Error('Usage: registry:client <list|search|inspect|install> [arguments] [--base URL]')
}
