import {
  Container,
  ContainerProxy,
  getContainer,
  type OutboundHandlerContext,
} from '@cloudflare/containers'
import {
  activeRegistryRun,
  isAllowedRegistryListPrefix,
  isImmutableRegistryKey,
  isRegistryStateKey,
  objectKey,
  type ActiveRegistryRun,
} from './registry-access'
import { processOutputWithTimeout, SingleFlight, startRunHeartbeat } from './run-control'

interface RefreshResult {
  exitCode: number
  output: string
  skipped?: 'already_running'
}

const activeRunStorageKey = 'active-run'
const activeRunTtlMs = 2 * 60 * 1000
const activeRunHeartbeatMs = 30 * 1000
const refreshExecutionTimeoutMs = 45 * 60 * 1000
const outputDecoder = new TextDecoder()
const maxLoggedOutputChars = 12_000

function clippedOutput(stdout: ArrayBuffer, stderr: ArrayBuffer) {
  const text = [outputDecoder.decode(stdout), outputDecoder.decode(stderr)].filter(Boolean).join('\n').trim()
  return text.length <= maxLoggedOutputChars ? text : `${text.slice(-maxLoggedOutputChars)}\n[output truncated]`
}

async function writeR2Object(request: Request, env: WriterEnv, key: string) {
  if (request.method !== 'PUT') return new Response('Method not allowed', { status: 405 })
  const object = await env.SKILL_REGISTRY_BUCKET.put(key, request.body, { onlyIf: request.headers })
  if (!object) return new Response(null, { status: 412 })
  return new Response(null, { status: 201, headers: { etag: object.httpEtag } })
}

async function immutableR2Request(request: Request, env: WriterEnv) {
  const url = new URL(request.url)
  if (url.pathname === '/list' && request.method === 'GET') {
    const prefix = url.searchParams.get('prefix') ?? ''
    if (!isAllowedRegistryListPrefix(prefix)) return new Response('Forbidden prefix', { status: 403 })
    const cursor = url.searchParams.get('cursor') ?? undefined
    const delimiter = url.searchParams.get('delimiter') ?? undefined
    const page = await env.SKILL_REGISTRY_BUCKET.list({ prefix, cursor, delimiter })
    return Response.json({
      keys: delimiter ? page.delimitedPrefixes ?? [] : page.objects.map((object) => object.key),
      cursor: page.truncated ? page.cursor : undefined,
    })
  }

  const key = objectKey(url.pathname)
  if (!key) return new Response('Not found', { status: 404 })
  if (isRegistryStateKey(key)) {
    if (request.method !== 'GET') return new Response('Registry state writes require the owning Writer', { status: 403 })
  } else if (!isImmutableRegistryKey(key)) {
    return new Response('Forbidden key', { status: 403 })
  }

  if (request.method === 'GET') {
    const object = await env.SKILL_REGISTRY_BUCKET.get(key)
    if (!object) return new Response(null, { status: 404 })
    return new Response(object.body, {
      headers: {
        etag: object.httpEtag,
        ...(object.size != null ? { 'content-length': String(object.size) } : {}),
      },
    })
  }
  if (request.method === 'PUT') {
    if (request.headers.get('if-none-match') !== '*') {
      return new Response('Immutable Registry keys require If-None-Match: *', { status: 428 })
    }
    return writeR2Object(request, env, key)
  }
  return new Response('Method not allowed', { status: 405 })
}

async function mutableR2Request(request: Request, env: WriterEnv, ctx: OutboundHandlerContext) {
  const token = request.headers.get('x-registry-writer-token')
  if (!token) return new Response('Missing writer token', { status: 401 })
  const writer = env.REGISTRY_WRITER.get(env.REGISTRY_WRITER.idFromString(ctx.containerId))
  return writer.writeState(token, request)
}

export class RegistryWriter extends Container<WriterEnv> {
  override sleepAfter = '1m'

  private mutationChain = Promise.resolve()
  private readonly refreshFlight = new SingleFlight<RefreshResult>()

  private async serialized<T>(operation: () => Promise<T>) {
    const next = this.mutationChain.then(operation, operation)
    this.mutationChain = next.then(() => undefined, () => undefined)
    return next
  }

  async refreshDue(): Promise<RefreshResult> {
    return this.refreshFlight.run(() => this.runRefreshDue())
  }

  private async beginRun() {
    return this.serialized(async () => {
      const raw = await this.ctx.storage.get(activeRunStorageKey)
      const stored = activeRegistryRun(raw)
      if (stored) return null
      const now = Date.now()
      const run: ActiveRegistryRun = {
        token: crypto.randomUUID(),
        started_at: new Date(now).toISOString(),
        expires_at: new Date(now + activeRunTtlMs).toISOString(),
      }
      await this.ctx.storage.put(activeRunStorageKey, run)
      return { run, replacedExpiredRun: raw != null }
    })
  }

  private async renewRun(token: string) {
    return this.serialized(async () => {
      const stored = await this.ctx.storage.get<ActiveRegistryRun>(activeRunStorageKey)
      if (!stored || stored.token !== token) return false
      await this.ctx.storage.put(activeRunStorageKey, {
        ...stored,
        expires_at: new Date(Date.now() + activeRunTtlMs).toISOString(),
      })
      return true
    })
  }

  private async finishRun(token: string) {
    await this.serialized(async () => {
      const stored = await this.ctx.storage.get<ActiveRegistryRun>(activeRunStorageKey)
      if (stored?.token === token) await this.ctx.storage.delete(activeRunStorageKey)
    })
  }

  private async runRefreshDue(): Promise<RefreshResult> {
    const started = await this.beginRun()
    if (!started) {
      return { exitCode: 0, output: 'Registry refresh already running', skipped: 'already_running' }
    }
    const { run, replacedExpiredRun } = started
    let heartbeatFailure: Error | undefined
    let process: ExecProcess | undefined
    try {
      if (replacedExpiredRun && this.ctx.container?.running) await this.stop('SIGKILL')
      await this.start()
      process = await this.ctx.container!.exec(
        ['env', `REGISTRY_WRITER_TOKEN=${run.token}`, 'bun', 'scripts/registry/refresh.ts', '--due'],
        { cwd: '/app' },
      )
      const stopHeartbeat = startRunHeartbeat(
        () => {
          // container.exec work is invisible to the SDK activity timeout that
          // backs sleepAfter, so an active run must renew it explicitly or the
          // Container base class stops the instance mid-refresh.
          this.renewActivityTimeout()
          return this.renewRun(run.token)
        },
        (error) => {
          heartbeatFailure = error
          process?.kill(15)
        },
        activeRunHeartbeatMs,
      )
      const result = await processOutputWithTimeout(process, refreshExecutionTimeoutMs)
        .finally(stopHeartbeat)
      if (heartbeatFailure) throw heartbeatFailure
      const output = clippedOutput(result.stdout, result.stderr)
      if (result.exitCode !== 0) {
        throw new Error(`Registry refresh failed with exit code ${result.exitCode}${output ? `:\n${output}` : ''}`)
      }
      return { exitCode: result.exitCode, output }
    } finally {
      await this.finishRun(run.token)
    }
  }

  async writeState(token: string, request: Request): Promise<Response> {
    return this.serialized(async () => {
      const run = activeRegistryRun(await this.ctx.storage.get(activeRunStorageKey))
      if (!run || run.token !== token) return new Response('Stale writer token', { status: 409 })
      const key = objectKey(new URL(request.url).pathname)
      if (!key || !isRegistryStateKey(key)) return new Response('Not found', { status: 404 })
      return writeR2Object(request, this.env, key)
    })
  }

  static override outboundByHost = {
    'registry-r2': immutableR2Request,
    'registry-mutable': mutableR2Request,
  }
}

export { ContainerProxy }

export default {
  async fetch(): Promise<Response> {
    return new Response('Not found', { status: 404 })
  },

  async scheduled(controller: ScheduledController, env: WriterEnv): Promise<void> {
    console.log(JSON.stringify({ event: 'registry_refresh_started', scheduled_at: controller.scheduledTime }))
    try {
      const writer = getContainer(env.REGISTRY_WRITER, 'singleton')
      const result = await writer.refreshDue()
      console.log(JSON.stringify({
        event: result.skipped ? 'registry_refresh_skipped' : 'registry_refresh_completed',
        reason: result.skipped,
        output: result.output,
      }))
    } catch (error) {
      console.error(JSON.stringify({
        event: 'registry_refresh_failed',
        error: error instanceof Error ? error.message : String(error),
      }))
      throw error
    }
  },
} satisfies ExportedHandler<WriterEnv>
