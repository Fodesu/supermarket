import { Container, ContainerProxy, getContainer } from '@cloudflare/containers'
import { DurableObject } from 'cloudflare:workers'

interface WriterEnv {
  SKILL_REGISTRY_BUCKET: R2Bucket
  REGISTRY_WRITER: DurableObjectNamespace<RegistryWriter>
  REGISTRY_COORDINATOR: DurableObjectNamespace<RegistryCoordinator>
}

interface RefreshResult {
  exitCode: number
  output: string
}

interface ActiveLease {
  token: string
  owner: string
  etag: string
}

const outputDecoder = new TextDecoder()
const maxLoggedOutputChars = 12_000

function clippedOutput(stdout: ArrayBuffer, stderr: ArrayBuffer) {
  const text = [outputDecoder.decode(stdout), outputDecoder.decode(stderr)].filter(Boolean).join('\n').trim()
  return text.length <= maxLoggedOutputChars ? text : `${text.slice(-maxLoggedOutputChars)}\n[output truncated]`
}

export class RegistryWriter extends Container {
  sleepAfter = '1m'
  envVars = {
    REGISTRY_R2_INTERNAL_URL: 'http://registry-r2',
    REGISTRY_R2_MUTABLE_URL: 'http://registry-mutable',
  }

  async refreshDue(token: string): Promise<RefreshResult> {
    if (!this.ctx.container.running) await this.start()
    const process = await this.ctx.container.exec(
      ['env', `REGISTRY_WRITER_TOKEN=${token}`, 'bun', 'scripts/skill-registry-refresh.ts', '--due'],
      { cwd: '/app' },
    )
    const result = await process.output()
    const output = clippedOutput(result.stdout, result.stderr)
    if (result.exitCode !== 0) {
      throw new Error(`Registry refresh failed with exit code ${result.exitCode}${output ? `:\n${output}` : ''}`)
    }
    return { exitCode: result.exitCode, output }
  }
}

function mutableKey(pathname: string) {
  if (!pathname.startsWith('/objects/')) return undefined
  const key = decodeURIComponent(pathname.slice('/objects/'.length))
  return /^skill-registries\/[^/]+\/(?:definition|current|status)\.json$/.test(key) ? key : undefined
}

function immutableKey(key: string) {
  return /^skill-artifacts\/[a-f0-9]{64}\.(?:json|tar\.gz)$/.test(key)
    || /^skill-images\/[a-f0-9]{64}(?:\.json)?$/.test(key)
    || /^skill-registries\/[^/]+\/catalogs\/[a-f0-9]{64}\.json$/.test(key)
}

function allowedListPrefix(prefix: string) {
  return ['skill-registries/', 'skill-artifacts/', 'skill-images/'].includes(prefix)
}

async function r2Mutation(request: Request, env: WriterEnv, key: string) {
  if (request.method === 'PUT') {
    const object = await env.SKILL_REGISTRY_BUCKET.put(key, request.body, { onlyIf: request.headers })
    if (!object) return new Response(null, { status: 412 })
    return new Response(null, { status: 201, headers: { etag: object.httpEtag } })
  }
  return new Response('Method not allowed', { status: 405 })
}

export class RegistryCoordinator extends DurableObject<WriterEnv> {
  private mutationChain = Promise.resolve()
  private activeRefresh: Promise<RefreshResult> | undefined
  private readonly leaseKey = 'skill-registry-maintenance/writer-lease.json'

  private async serialized<T>(operation: () => Promise<T>) {
    const next = this.mutationChain.then(operation, operation)
    this.mutationChain = next.then(() => undefined, () => undefined)
    return next
  }

  async refreshDue(): Promise<RefreshResult> {
    if (this.activeRefresh) return this.activeRefresh
    const refresh = this.runRefreshDue()
    this.activeRefresh = refresh
    try {
      return await refresh
    } finally {
      if (this.activeRefresh === refresh) this.activeRefresh = undefined
    }
  }

  private async runRefreshDue(): Promise<RefreshResult> {
    const token = crypto.randomUUID()
    await this.serialized(() => this.acquireLease(token))
    const heartbeat = this.startHeartbeat(token)
    try {
      const writer = getContainer(this.env.REGISTRY_WRITER, 'singleton')
      const result = await writer.refreshDue(token)
      heartbeat.assertActive()
      return result
    } finally {
      heartbeat.stop()
      await this.serialized(async () => {
        const activeLease = await this.ctx.storage.get<ActiveLease>('active-lease')
        if (activeLease?.token === token) {
          await this.ctx.storage.delete('active-lease')
          await this.releaseLease(activeLease)
        }
      })
    }
  }

  async runScheduled(): Promise<RefreshResult> {
    return this.refreshDue()
  }

  private startHeartbeat(token: string) {
    let failure: unknown
    let running = false
    const renew = () => {
      if (running || failure) return
      running = true
      void this.serialized(() => this.renewLease(token)).catch((error) => { failure = error }).finally(() => { running = false })
    }
    const timer = setInterval(renew, 30_000)
    return {
      stop() { clearInterval(timer) },
      assertActive() {
        if (failure) throw failure
      },
    }
  }

  private async acquireLease(token: string) {
    const current = await this.env.SKILL_REGISTRY_BUCKET.get(this.leaseKey)
    const now = Date.now()
    if (current) {
      const lease = JSON.parse(await current.text()) as { owner?: unknown; expires_at?: unknown; released_at?: unknown }
      const expiresAt = typeof lease.expires_at === 'string' ? Date.parse(lease.expires_at) : Number.NaN
      if (!lease.released_at && Number.isFinite(expiresAt) && expiresAt > now) {
        throw new Error(`Registry writer lease is already held by ${typeof lease.owner === 'string' ? lease.owner : 'an unknown owner'}`)
      }
    }
    const owner = crypto.randomUUID()
    const expiresAt = new Date(now + 15 * 60 * 1000).toISOString()
    const result = await this.env.SKILL_REGISTRY_BUCKET.put(this.leaseKey, JSON.stringify({
      owner, holder: 'cloudflare-registry-coordinator', acquired_at: new Date(now).toISOString(),
      renewed_at: new Date(now).toISOString(), expires_at: expiresAt, fencing_token: token,
    }), { onlyIf: current ? { etagMatches: current.etag } : { etagDoesNotMatch: '*' } })
    if (!result) throw new Error('Registry writer lease changed while acquiring it')
    const lease = { token, owner, etag: result.etag }
    await this.ctx.storage.put('active-lease', lease)
    return lease
  }

  private async renewLease(token: string) {
    const lease = await this.ctx.storage.get<ActiveLease>('active-lease')
    if (!lease || lease.token !== token) throw new Error('Stale writer token')
    const now = new Date().toISOString()
    const result = await this.env.SKILL_REGISTRY_BUCKET.put(this.leaseKey, JSON.stringify({
      owner: lease.owner, holder: 'cloudflare-registry-coordinator', renewed_at: now,
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(), fencing_token: token,
    }), { onlyIf: { etagMatches: lease.etag } })
    if (!result) {
      await this.ctx.storage.delete('active-lease')
      throw new Error('Registry writer lease was lost')
    }
    const renewed = { ...lease, etag: result.etag }
    await this.ctx.storage.put('active-lease', renewed)
    return renewed
  }

  private async releaseLease(lease: ActiveLease) {
    const now = new Date().toISOString()
    const result = await this.env.SKILL_REGISTRY_BUCKET.put(this.leaseKey, JSON.stringify({
      owner: lease.owner, holder: 'cloudflare-registry-coordinator', renewed_at: now,
      expires_at: now, released_at: now,
    }), { onlyIf: { etagMatches: lease.etag } })
    if (!result) throw new Error('Registry writer lease changed before release')
  }

  async mutate(token: string, request: Request): Promise<Response> {
    return this.serialized(async () => {
      const activeLease = await this.ctx.storage.get<ActiveLease>('active-lease')
      if (!activeLease || activeLease.token !== token) return new Response('Stale writer token', { status: 409 })
      await this.renewLease(token)
      const key = mutableKey(new URL(request.url).pathname)
      if (!key) return new Response('Not found', { status: 404 })
      return r2Mutation(request, this.env, key)
    })
  }
}

RegistryWriter.outboundByHost = {
  'registry-r2': async (request, env: WriterEnv) => {
    const url = new URL(request.url)
    if (url.pathname === '/list' && request.method === 'GET') {
      const prefix = url.searchParams.get('prefix') ?? ''
      if (!allowedListPrefix(prefix)) return new Response('Forbidden prefix', { status: 403 })
      const cursor = url.searchParams.get('cursor') ?? undefined
      const delimiter = url.searchParams.get('delimiter') ?? undefined
      const page = await env.SKILL_REGISTRY_BUCKET.list({ prefix, cursor, delimiter })
      return Response.json({ keys: delimiter ? page.delimitedPrefixes ?? [] : page.objects.map((object) => object.key), cursor: page.truncated ? page.cursor : undefined })
    }
    if (!url.pathname.startsWith('/objects/')) return new Response('Not found', { status: 404 })
    const key = decodeURIComponent(url.pathname.slice('/objects/'.length))
    if (!key || key.includes('\0') || key.split('/').some((part) => part === '..')) return new Response('Invalid key', { status: 400 })
    if (mutableKey(url.pathname)) {
      if (request.method !== 'GET') return new Response('Mutable Registry keys require the coordinator', { status: 403 })
    } else if (!immutableKey(key)) {
      return new Response('Forbidden key', { status: 403 })
    }
    if (request.method === 'GET') {
      const object = await env.SKILL_REGISTRY_BUCKET.get(key)
      if (!object) return new Response(null, { status: 404 })
      return new Response(object.body, { headers: { etag: object.httpEtag } })
    }
    if (request.method === 'PUT') {
      if (request.headers.get('if-none-match') !== '*') {
        return new Response('Immutable Registry keys require If-None-Match: *', { status: 428 })
      }
      const object = await env.SKILL_REGISTRY_BUCKET.put(key, request.body, { onlyIf: { etagDoesNotMatch: '*' } })
      if (!object) return new Response(null, { status: 412 })
      return new Response(null, { status: 201, headers: { etag: object.httpEtag } })
    }
    return new Response('Method not allowed', { status: 405 })
  },
  'registry-mutable': async (request, env: WriterEnv, ctx) => {
    const token = request.headers.get('x-registry-writer-token')
    if (!token) return new Response('Missing writer token', { status: 401 })
    const coordinator = env.REGISTRY_COORDINATOR.getByName('singleton')
    return coordinator.mutate(token, request)
  },
}

export { ContainerProxy }

export default {
  async fetch(): Promise<Response> {
    return new Response('Not found', { status: 404 })
  },

  async scheduled(_controller: ScheduledController, env: WriterEnv): Promise<void> {
    console.log('Registry scheduled run started')
    try {
      const coordinator = env.REGISTRY_COORDINATOR.getByName('singleton')
      const result = await coordinator.runScheduled()
      console.log(result.output || 'Registry refresh completed without output')
    } catch (error) {
      console.error('Registry scheduled run failed', error)
      throw error
    }
  },
} satisfies ExportedHandler<WriterEnv>
