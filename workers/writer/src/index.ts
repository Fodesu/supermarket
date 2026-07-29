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

// Secret set via `wrangler secret put WRITER_REFRESH_TOKEN`. It has no value in
// wrangler config (secrets never do), so augment the generated env type here.
declare global {
  interface WriterEnv {
    WRITER_REFRESH_TOKEN?: string
  }
}

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
const registryContainerEnv = {
  REGISTRY_BLOBS_URL: 'http://registry-blobs',
  REGISTRY_STATE_URL: 'http://registry-state',
} as const

function clippedOutput(stdout: ArrayBuffer, stderr: ArrayBuffer) {
  const text = [outputDecoder.decode(stdout), outputDecoder.decode(stderr)].filter(Boolean).join('\n').trim()
  return text.length <= maxLoggedOutputChars ? text : `${text.slice(-maxLoggedOutputChars)}\n[output truncated]`
}

async function writeR2Object(request: Request, env: WriterEnv, key: string) {
  if (request.method !== 'PUT') return new Response('Method not allowed', { status: 405 })
  const contentLengthHeader = request.headers.get('content-length')
  if (contentLengthHeader === null) return new Response('Content-Length is required', { status: 411 })
  const contentLength = Number(contentLengthHeader)
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
    return new Response('A valid Content-Length is required', { status: 411 })
  }

  const body = request.body
  if (!body && contentLength !== 0) return new Response('Request body is missing', { status: 400 })

  let object: R2Object | null
  if (!body) {
    object = await env.SKILL_REGISTRY_BUCKET.put(key, null, { onlyIf: request.headers })
  } else {
    // Container outbound requests arrive as generic streams. R2 accepts
    // streams only when their length is carried by FixedLengthStream.
    const fixed = new FixedLengthStream(contentLength)
    const pipeController = new AbortController()
    const piped = body.pipeTo(fixed.writable, { signal: pipeController.signal })
    try {
      object = await env.SKILL_REGISTRY_BUCKET.put(key, fixed.readable, { onlyIf: request.headers })
    } catch (error) {
      pipeController.abort(error)
      await piped.catch(() => {})
      throw error
    }
    if (!object) pipeController.abort()
    await piped.catch((error) => {
      if (!pipeController.signal.aborted) throw error
    })
  }
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
  override envVars = registryContainerEnv

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
        ['bun', 'scripts/registry/refresh.ts', '--due'],
        {
          cwd: '/app',
          // exec's env replaces rather than extends the command environment,
          // so include the Container-level routing variables here as well.
          env: { ...registryContainerEnv, REGISTRY_WRITER_TOKEN: run.token },
        },
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

}

// `Container.outboundByHost` is an inherited static setter. A static class
// field would shadow that setter instead of registering these handlers.
RegistryWriter.outboundByHost = {
  'registry-blobs': immutableR2Request,
  'registry-state': mutableR2Request,
}

export { ContainerProxy }

async function runScheduledRefresh(env: WriterEnv, trigger: 'cron' | 'manual'): Promise<void> {
  console.log(JSON.stringify({ event: 'registry_refresh_started', trigger }))
  try {
    const writer = getContainer(env.REGISTRY_WRITER, 'singleton')
    const result = await writer.refreshDue()
    console.log(JSON.stringify({
      event: result.skipped ? 'registry_refresh_skipped' : 'registry_refresh_completed',
      trigger,
      reason: result.skipped,
      output: result.output,
    }))
  } catch (error) {
    console.error(JSON.stringify({
      event: 'registry_refresh_failed',
      trigger,
      error: error instanceof Error ? error.message : String(error),
    }))
    throw error
  }
}

// Manual refresh trigger. The test Writer has no cron by design (see
// scripts/registry/check-config.ts), so this token-guarded endpoint is how a
// refresh is kicked off there on demand. The run happens in waitUntil so the
// request returns immediately; poll R2 state to observe progress.
async function handleManualRefresh(request: Request, env: WriterEnv, ctx: ExecutionContext): Promise<Response> {
  const expected = env.WRITER_REFRESH_TOKEN
  if (!expected) return new Response('Manual refresh is not configured', { status: 501 })
  const provided = request.headers.get('x-writer-refresh-token')
  if (!provided || provided !== expected) return new Response('Forbidden', { status: 403 })
  ctx.waitUntil(runScheduledRefresh(env, 'manual'))
  return new Response(null, { status: 202 })
}

export default {
  async fetch(request: Request, env: WriterEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/__refresh' && request.method === 'POST') {
      return handleManualRefresh(request, env, ctx)
    }
    return new Response('Not found', { status: 404 })
  },

  async scheduled(_controller: ScheduledController, env: WriterEnv): Promise<void> {
    await runScheduledRefresh(env, 'cron')
  },
} satisfies ExportedHandler<WriterEnv>
