import Koa from 'koa'
import bodyParser from 'koa-bodyparser'
import { createServer, type Server } from 'node:http'
import type { Socket, AddressInfo } from 'node:net'
import routes from '../proxy/routes'
import { internalProxyKey, isInternalProxyKey } from '../proxy/internalAuth'
import { closeHttpServer } from '../proxy/serverLifecycle'
import { storeManager } from '../store/store'

/**
 * Preferred, stable ports: terminals run in a detached host that survives app restarts, and their
 * CLIs keep the bridge URL they were started with. A stable port lets them reconnect.
 */
export const INTERNAL_INFERENCE_PORTS = [11435, 11436, 11437, 11438, 11439] as const

/** Ports the public proxy uses or may use; the bridge must never take one of them. */
export function reservedProxyPorts(): ReadonlySet<number> {
  const config = storeManager.getConfig()
  return new Set([11434, config.proxyPort, ...(config.additionalProxyListeners || []).map(listener => listener.port)]
    .filter(port => Number.isInteger(port)))
}

/** Compatibility transport for native CLIs only. Independent of the public API server. */
export class InternalInferenceBridge {
  private server?: Server
  private starting?: Promise<{ baseURL: string; apiKey: string }>
  /** Owned by the bridge server alone; sockets add and remove themselves. */
  private readonly connections = new Set<Socket>()

  connection(): Promise<{ baseURL: string; apiKey: string }> {
    if (this.starting) return this.starting
    if (this.server?.listening) return Promise.resolve(this.address(this.server))
    const pending = this.start()
    this.starting = pending
    void pending.then(() => { this.starting = undefined }, () => { this.starting = undefined })
    return pending
  }

  private address(server: Server): { baseURL: string; apiKey: string } {
    return { baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, apiKey: internalProxyKey }
  }

  private async start(): Promise<{ baseURL: string; apiKey: string }> {
    const app = new Koa()
    app.use(async (ctx, next) => {
      try { await next() } catch (error) {
        const status = Number((error as { status?: number }).status) || 500
        ctx.status = status >= 400 && status < 600 ? status : 500
        ctx.body = { error: { message: error instanceof Error ? error.message : 'Internal inference failed' } }
        storeManager.addLog('error', 'Internal inference bridge request failed', { error: String(error) })
      }
    })
    app.use(async (ctx, next) => {
      if (ctx.get('Origin')) { ctx.status = 403; return }
      const key = ctx.get('Authorization').replace(/^Bearer\s+/i, '') || ctx.get('x-api-key')
      if (!isInternalProxyKey(key)) { ctx.status = 401; ctx.body = { error: { message: 'Internal client authentication required' } }; return }
      ctx.req.headers = { ...ctx.req.headers, 'x-dailyworkmate-model-selection': 'explicit' }
      await next()
    })
    app.use(bodyParser({ jsonLimit: '50mb', formLimit: '50mb', textLimit: '50mb' }))
    for (const router of routes) app.use(router.routes()).use(router.allowedMethods())
    // OS allocation is the fallback when Windows reserves the entire preferred range.
    const reserved = reservedProxyPorts()
    for (const port of [...INTERNAL_INFERENCE_PORTS.filter(candidate => !reserved.has(candidate)), 0, 0, 0]) {
      const server = createServer(app.callback())
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
        })
      } catch (error) {
        if (port && ['EACCES', 'EADDRINUSE'].includes((error as NodeJS.ErrnoException).code || '')) continue
        throw error
      }
      if (reserved.has((server.address() as AddressInfo).port)) {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
        continue
      }
      server.on('error', error => storeManager.addLog('error', 'Internal inference bridge server error', { error: error.message }))
      server.on('connection', socket => {
        this.connections.add(socket)
        socket.once('close', () => this.connections.delete(socket))
      })
      this.server = server
      const connection = this.address(server)
      storeManager.addLog('info', `Internal model compatibility service listening on ${connection.baseURL}`)
      return connection
    }
    throw new Error('Unable to allocate an internal model service port')
  }

  async stop(): Promise<void> {
    // A failed start was already reported to whoever asked for the connection; it must not
    // abort shutdown, and there is no server to close in that case.
    if (this.starting) await this.starting.catch(error => storeManager.addLog('debug', 'Internal inference bridge was not running at shutdown', { error: String(error) }))
    const server = this.server
    this.server = undefined
    if (server?.listening) await closeHttpServer(server, this.connections)
  }
}

export const internalInferenceBridge = new InternalInferenceBridge()
