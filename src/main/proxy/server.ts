/**
 * Proxy Service Module - Proxy Server Core
 * Implements proxy server based on Koa
 */

import { app as electronApp, BrowserWindow } from 'electron'
import Koa, { type Context, type Next } from 'koa'
import Router from '@koa/router'
import bodyParser from 'koa-bodyparser'
import { Server as HttpServer } from 'http'
import { isIP, type Socket } from 'net'
import routes from './routes'
import managementRoutes from './routes/management'
import { proxyStatusManager } from './status'
import { storeManager } from '../store/store'
import { closeHttpServer } from './serverLifecycle'
import { isInternalProxyKey } from './internalAuth'
import { describeProxyListenError } from './listenError'
import { authorizeApiKey } from './apiKeyAuth'
import { isLoopbackAddress } from '../../shared/proxyListeners'
import { freeModelSource } from '../../shared/freeModels'

const SLOW_REQUEST_THRESHOLD_MS = 1500

interface ActiveListener {
  readonly server: HttpServer
  readonly port: number
  readonly host: string
  readonly startedAt: number
  /** Owned by this listener only; sockets add and remove themselves as they open and close. */
  readonly connections: Set<Socket>
}

/**
 * Proxy Server Class
 */
export class ProxyServer {
  private app: Koa
  private router: Router
  private listeners: readonly ActiveListener[] = []
  private lifecycleQueue: Promise<void> = Promise.resolve()
  private sharedLifecycleActive = false
  private lastError: string | undefined
  private port: number = 11434
  private host: string = '127.0.0.1'

  constructor() {
    this.app = new Koa()
    this.router = new Router()

    this.setupMiddleware()
    this.setupRoutes()
    this.setupErrorHandler()
  }

  /**
   * Setup middleware
   */
  private statusListeners = new Set<(running: boolean) => void>()
  subscribeStatus(listener: (running: boolean) => void): () => void { this.statusListeners.add(listener); return () => { this.statusListeners.delete(listener) } }
  private broadcastStatus() {
    const status = this.getStatus()
    for (const listener of this.statusListeners) {
      try { listener(status.isRunning) } catch (error) {
        storeManager.addLog('error', `Proxy status subscriber failed: ${String(error)}`)
      }
    }
    for (const window of BrowserWindow.getAllWindows()) {
      try { if (!window.isDestroyed()) window.webContents.send('proxy:statusChanged', status) } catch (error) {
        storeManager.addLog('error', `Proxy status notification failed: ${String(error)}`)
      }
    }
  }
  private setupMiddleware(): void {
    this.app.use(async (ctx, next) => {
      const origin = ctx.get('Origin')
      const desktopOrigin = process.env.ELECTRON_RENDERER_URL
      const allowed = !origin || origin === 'null' || (desktopOrigin && origin === new URL(desktopOrigin).origin)
      if (!allowed) { ctx.status = 403; ctx.body = { error: { code: 'origin_not_allowed', message: 'This browser origin cannot access the local proxy' } }; return }
      if (origin) { ctx.set('Access-Control-Allow-Origin', origin); ctx.vary('Origin') }
      ctx.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
      ctx.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-API-Key, X-Enable-Vision, X-Enable-Thinking, X-Reasoning-Effort, X-Web-Search, X-Deep-Research, X-DailyWorkMate-Model-Selection, X-Refresh-Free-Models, X-OpenCode-Session-Id, X-OpenCode-Session, X-Session-Id')
      ctx.set('Access-Control-Max-Age', '86400')

      if (ctx.method === 'OPTIONS') {
        ctx.status = 204
        return
      }

      if (origin === 'null' && !isInternalProxyKey(ctx.get('Authorization').replace(/^Bearer /, '')) && !(ctx.path.startsWith('/v0/management/') && storeManager.getConfig().managementApi.managementApiSecret && ctx.get('Authorization') === 'Bearer ' + storeManager.getConfig().managementApi.managementApiSecret)) {
        ctx.status = 403; ctx.body = { error: { code: 'origin_not_allowed', message: 'Desktop authentication is required' } }; return
      }
      await next()
    })

    this.app.use(bodyParser({
      jsonLimit: '50mb',
      formLimit: '50mb',
      textLimit: '50mb',
    }))

    // API Key validation middleware
    this.app.use(async (ctx, next) => {
      // Skip paths that don't require authentication
      const publicPaths = ['/', '/health']
      if (publicPaths.includes(ctx.path)) {
        await next()
        return
      }

      // Skip management API paths - they have their own authentication
      if (ctx.path.startsWith('/v0/management')) {
        await next()
        return
      }

      const config = storeManager.getConfig()
      const authHeader = ctx.get('Authorization') || ''
      // The internal desktop key never leaves this machine, so it is only honoured on loopback.
      if (isLoopbackAddress(ctx.socket?.remoteAddress) && isInternalProxyKey(authHeader.replace(/^Bearer /, ''))) { await next(); return }
      const query = ctx.query.api_key
      const auth = authorizeApiKey({
        enableApiKey: config.enableApiKey, apiKeys: config.apiKeys,
        providedKey: authHeader.startsWith('Bearer ') ? authHeader.slice(7) : (typeof query === 'string' ? query : '') || ctx.get('X-API-Key'),
        localAddress: ctx.socket?.localAddress, remoteAddress: ctx.socket?.remoteAddress,
      })
      if (!auth.ok) {
        ctx.status = 401
        ctx.body = { error: { message: auth.message, type: 'invalid_request_error', code: auth.code } }
        return
      }
      if (auth.keyId) storeManager.recordApiKeyUsage(auth.keyId)

      await next()
    })

    this.app.use(async (ctx, next) => {
      const startTime = Date.now()

      await next()

      if (/^\/(?:v1\/(?:chat\/completions|completions|messages)|api\/(?:chat|generate|tags|show|version))$/.test(ctx.path) && !ctx.state.requestLogged) {
        let recorded = false
        const record = (disconnected = false) => {
          if (recorded) return
          recorded = true
          const request = ctx.request.body as Record<string, any> | undefined
          const selected = ctx.state.dispatchSelection
          const model = typeof request?.model === 'string' ? request.model : ''
          const free = freeModelSource(ctx.state.routedModel || selected?.actualModel || model)
          const failure = ctx.state.streamError || (disconnected ? 'Client disconnected before completion' : undefined)
          const failed = Boolean(failure) || ctx.status >= 400
          // Bodies can be up to 50MB; serialize them only when the log will keep them.
          const logConfig = storeManager.getConfig().requestLogConfig
          const keepBodies = Boolean(logConfig?.enabled && logConfig.includeBodies)
          const body = ctx.state.responseLogBody || (ctx.body && typeof ctx.body === 'object' && !('pipe' in ctx.body) ? JSON.stringify(ctx.body) : '')
          storeManager.addRequestLog({
            timestamp: startTime, status: failed ? 'error' : 'success', statusCode: failure ? 502 : ctx.status,
            method: ctx.method, url: ctx.path, model: String(request?.model || ''),
            actualModel: selected?.actualModel || free?.apiModel,
            providerId: selected?.provider.id || free?.id,
            providerName: selected?.provider.name || free?.name,
            accountId: selected?.account.id, accountName: selected?.account.name,
            requestBody: request && keepBodies ? JSON.stringify(request) : undefined,
            userInput: typeof request?.prompt === 'string' ? request.prompt : JSON.stringify(request?.messages?.filter((message: any) => message.role === 'user').slice(-1) || []),
            responseStatus: failure ? 502 : ctx.status, responseBody: body, responsePreview: body.slice(0, 500),
            latency: Date.now() - startTime, isStream: Boolean(request?.stream), errorMessage: failure || (failed ? body.slice(0, 500) : undefined),
          })
        }
        if (ctx.res.destroyed) record(true)
        else { ctx.res.once('finish', () => record()); ctx.res.once('close', () => record(!ctx.res.writableFinished)) }
      }

      const latency = Date.now() - startTime
      const shouldRecordAccessLog =
        !ctx.path.startsWith('/v1/models') &&
        (ctx.status >= 400 || latency >= SLOW_REQUEST_THRESHOLD_MS)

      if (shouldRecordAccessLog) {
        storeManager.addLog('warn', `${ctx.method} ${ctx.path} ${ctx.status} ${latency}ms`, {
          data: {
            method: ctx.method,
            path: ctx.path,
            status: ctx.status,
            latency,
            clientIP: ctx.ip,
            slowRequest: latency >= SLOW_REQUEST_THRESHOLD_MS,
          },
        })
      }
    })
  }

  /**
   * Setup routes
   */
  private setupRoutes(): void {
    // Register OpenAI API routes
    for (const route of routes) {
      this.router.use(route.routes())
      this.router.use(route.allowedMethods())
    }

    this.router.get('/', async (ctx) => {
      ctx.body = {
        name: 'DailyWorkMate Proxy',
        version: electronApp.getVersion(),
        description: 'OpenAI API compatible proxy service',
        endpoints: [
          'POST /v1/chat/completions',
          'GET /v1/models',
          'GET /v1/models/:model',
          'POST /v1/completions',
          'POST /v1/messages',
          'POST /api/chat',
          'GET /api/tags',
        ],
      }
    })

    this.router.get('/health', async (ctx) => {
      const status = proxyStatusManager.getRunningStatus()
      const statistics = proxyStatusManager.getStatistics()

      ctx.body = {
        status: status.isRunning ? 'running' : 'stopped',
        version: electronApp.getVersion(),
        uptime: status.uptime,
        statistics: {
          totalRequests: statistics.totalRequests,
          successRequests: statistics.successRequests,
          failedRequests: statistics.failedRequests,
          activeConnections: statistics.activeConnections,
        },
      }
    })

    this.router.get('/stats', async (ctx) => {
      const statistics = proxyStatusManager.getStatistics()
      ctx.body = statistics
    })

    // Management API enable check middleware
    // This must be registered before management routes
    const managementEnableCheck = async (ctx: Context, next: Next) => {
      if (!ctx.path.startsWith('/v0/management')) {
        await next()
        return
      }

      try {
        const config = storeManager.getConfig()
        if (!config.managementApi?.enableManagementApi) {
          ctx.status = 404
          ctx.body = {
            success: false,
            error: {
              code: 'management_api_disabled',
              message: 'Management API is not enabled',
            },
          }
          return
        }
        await next()
      } catch {
        ctx.status = 503
        ctx.body = {
          success: false,
          error: {
            code: 'service_unavailable',
            message: 'Service is initializing',
          },
        }
      }
    }

    this.app.use(managementEnableCheck)

    // Register all management routes (they already have /v0/management prefix)
    for (const route of managementRoutes) {
      this.app.use(route.routes())
      this.app.use(route.allowedMethods())
    }

    this.app.use(this.router.routes())
    this.app.use(this.router.allowedMethods())

    this.app.use(async (ctx) => {
      ctx.status = 404
      ctx.body = {
        error: {
          message: `Route not found: ${ctx.method} ${ctx.path}`,
          type: 'not_found_error',
        },
      }
    })
  }

  /**
   * Setup error handler
   */
  private setupErrorHandler(): void {
    this.app.on('error', (err, ctx) => {
      const status = err.status || 500
      const message = err.message || 'Internal Server Error'

      storeManager.addLog('error', `Server error: ${message}`, {
        data: {
          status,
          path: ctx.path,
          method: ctx.method,
          stack: err.stack,
        },
      })
    })
  }

  // Serialize lifecycle changes so overlapping UI/workspace requests cannot bind
  // twice, stop a replacement listener, or tear down shared sessions mid-start.
  private enqueueLifecycle(operation: () => Promise<boolean>): Promise<boolean> {
    const result = this.lifecycleQueue.then(async () => {
      this.lastError = undefined
      try { return await operation() } catch (error) {
        return this.fail(`Proxy operation failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
    this.lifecycleQueue = result.then(() => undefined, () => undefined)
    return result
  }

  private fail(message: string): false {
    this.lastError = message
    storeManager.addLog('error', message)
    return false
  }

  private validateEndpoint(port: number, host: string): { port: number; host: string } | undefined {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      this.fail('Proxy port must be an integer between 1 and 65535')
      return undefined
    }
    if (typeof host !== 'string') {
      this.fail('Proxy host must be an IP address or hostname')
      return undefined
    }
    const normalizedHost = host.trim().toLowerCase().replace(/^\[([^\]]+)\]$/, '$1')
    const validHostname = normalizedHost.length <= 253 && normalizedHost.split('.').every(label =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    if (!isIP(normalizedHost) && !validHostname) {
      this.fail('Proxy host must be an IP address or hostname without a URL scheme or port')
      return undefined
    }
    return { port, host: normalizedHost }
  }

  private setPrimary(port: number, host: string): void {
    this.port = port
    this.host = host
    proxyStatusManager.updateConfig({ port, host })
  }

  private removeListener(server: HttpServer): void {
    const removed = this.listeners.find(listener => listener.server === server)
    if (!removed) return
    this.listeners = this.listeners.filter(listener => listener.server !== server)
    if (removed.port === this.port && removed.host === this.host && this.listeners.length) {
      const next = this.listeners[0]
      this.setPrimary(next.port, next.host)
    }
    if (!this.listeners.length && this.sharedLifecycleActive) {
      this.sharedLifecycleActive = false
      proxyStatusManager.stop()
    }
    this.broadcastStatus()
  }

  /** Start an additional endpoint, or succeed if that endpoint is already running. */
  start(port?: number, host?: string): Promise<boolean> {
    return this.enqueueLifecycle(() => this.startListener(port, host))
  }

  private async startListener(port?: number, host?: string): Promise<boolean> {
    const config = storeManager.getConfig()
    const requestedPort = port === undefined ? config.proxyPort : port
    const requestedHost = host === undefined ? config.proxyHost : host
    const endpoint = this.validateEndpoint(requestedPort === undefined ? this.port : requestedPort, requestedHost === undefined ? this.host : requestedHost)
    if (!endpoint) return false
    if (this.listeners.some(listener => listener.port === endpoint.port && listener.host === endpoint.host && listener.server.listening)) return true
    if (!['127.0.0.1', 'localhost', '::1'].includes(endpoint.host) &&
        (!config.enableApiKey || !config.apiKeys?.some(key => key.enabled && key.key?.trim()))) {
      return this.fail('Enable API key authentication and add an enabled key before exposing the proxy to the network')
    }

    return new Promise(resolve => {
      const server = new HttpServer(this.app.callback())
      // Copying the set per connection was O(n^2) under load; the set belongs to this server alone.
      const connections = new Set<Socket>()
      server.on('connection', connection => {
        connections.add(connection)
        connection.once('close', () => connections.delete(connection))
      })
      server.on('close', () => this.removeListener(server))
      const handleListenError = async (error: unknown): Promise<void> => {
        const message = await describeProxyListenError(error, endpoint, {
          language: config.language,
          onDiagnosticFailure: failure => storeManager.addLog('warn', `Unable to inspect Windows excluded TCP ports: ${String(failure)}`),
        })
        resolve(this.fail(message))
      }
      server.on('error', (error: NodeJS.ErrnoException) => { void handleListenError(error) })
      server.once('listening', () => {
        try {
          if (!this.sharedLifecycleActive) {
            proxyStatusManager.updateConfig({ timeout: config.requestTimeout, retryCount: config.retryCount })
            proxyStatusManager.start()
            this.sharedLifecycleActive = true
          }
          if (!this.listeners.length) this.setPrimary(endpoint.port, endpoint.host)
          this.listeners = [...this.listeners, { ...endpoint, server, startedAt: Date.now(), connections }]
          this.broadcastStatus()
          storeManager.addLog('info', `Proxy server started successfully, listening on ${endpoint.host}:${endpoint.port}`)
          resolve(true)
        } catch (error) {
          server.close()
          resolve(this.fail(`Failed to initialize proxy listener: ${error instanceof Error ? error.message : String(error)}`))
        }
      })
      try { server.listen(endpoint.port, endpoint.host) } catch (error) {
        void handleListenError(error)
      }
    })
  }

  /** Stop one endpoint; omitting the port preserves the legacy stop-all action. */
  stop(port?: number, host?: string): Promise<boolean> {
    return this.enqueueLifecycle(async () => {
      const endpoint = port === undefined ? undefined : this.validateEndpoint(port, host === undefined ? this.host : host)
      if (port !== undefined && !endpoint) return false
      const targets = this.listeners.filter(listener => !endpoint || (listener.port === endpoint.port && listener.host === endpoint.host))
      if (!targets.length) return true
      const results = await Promise.all(targets.map(listener => this.stopListener(listener)))
      return results.every(Boolean)
    })
  }

  private async stopListener(listener: ActiveListener): Promise<boolean> {
    try {
      await closeHttpServer(listener.server, listener.connections)
      this.removeListener(listener.server)
      storeManager.addLog('info', `Proxy server stopped on ${listener.host}:${listener.port}`)
      return true
    } catch (error) {
      return this.fail(`Failed to stop ${listener.host}:${listener.port}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Restart or move the primary endpoint without interrupting other listeners. */
  restart(port?: number, host?: string): Promise<boolean> {
    return this.enqueueLifecycle(async () => {
      const primary = this.listeners.find(listener => listener.port === this.port && listener.host === this.host)
      if (!primary) return this.startListener(port, host)
      const endpoint = this.validateEndpoint(port === undefined ? primary.port : port, host === undefined ? primary.host : host)
      if (!endpoint) return false
      const requiresRelease = endpoint.port === primary.port
      // Bind the replacement first where possible so a bad address cannot take
      // an otherwise healthy primary endpoint offline.
      if (!requiresRelease && !await this.startListener(endpoint.port, endpoint.host)) return false
      // Re-read the primary: the listener list is replaced as listeners start and stop.
      const current = this.listeners.find(listener => listener.server === primary.server)
      if (current && !await this.stopListener(current)) return false
      if (requiresRelease && !await this.startListener(endpoint.port, endpoint.host)) {
        const failure = this.lastError || 'Failed to restart the primary proxy listener'
        if (await this.startListener(primary.port, primary.host)) {
          this.setPrimary(primary.port, primary.host)
          this.broadcastStatus()
          return this.fail(failure)
        }
        return this.fail(`${failure}; the original endpoint could not be restored: ${this.lastError}`)
      }
      this.setPrimary(endpoint.port, endpoint.host)
      this.broadcastStatus()
      return true
    })
  }

  /**
   * Check if server is running
   */
  isRunning(): boolean {
    return this.listeners.some(listener => listener.server.listening)
  }

  /**
   * Get server port
   */
  getPort(): number {
    return this.port
  }

  getHost(): string {
    return this.host
  }

  getLastError(): string | undefined {
    return this.lastError
  }

  /**
   * Get statistics
   */
  getStatistics() {
    return proxyStatusManager.getStatistics()
  }

  /**
   * Get running status
   */
  getStatus() {
    return {
      ...proxyStatusManager.getRunningStatus(),
      isRunning: this.isRunning(),
      port: this.port,
      host: this.host,
      connections: proxyStatusManager.getStatistics().activeConnections,
      listeners: this.listeners.filter(listener => listener.server.listening).map(listener => ({
        port: listener.port,
        host: listener.host,
        isRunning: true,
        uptime: Date.now() - listener.startedAt,
        connections: listener.connections.size,
      })),
    }
  }

  /**
   * Reset statistics
   */
  resetStatistics(): void {
    proxyStatusManager.resetStatistics()
  }
}

export const proxyServer = new ProxyServer()
export default proxyServer
