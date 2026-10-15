/**
 * Proxy Service Module - Proxy Server Core
 * Implements proxy server based on Koa
 */

import { app as electronApp, BrowserWindow } from 'electron'
import Koa, { type Context, type Next } from 'koa'
import Router from '@koa/router'
import bodyParser from 'koa-bodyparser'
import { Server as HttpServer } from 'http'
import type { Socket } from 'net'
import routes from './routes'
import managementRoutes from './routes/management'
import { proxyStatusManager } from './status'
import { storeManager } from '../store/store'
import { sessionManager } from './sessionManager'
import { closeHttpServer } from './serverLifecycle'
import { isInternalProxyKey } from './internalAuth'

const SLOW_REQUEST_THRESHOLD_MS = 1500

/**
 * Proxy Server Class
 */
export class ProxyServer {
  private app: Koa
  private router: Router
  private server: HttpServer | null = null
  private connections = new Set<Socket>()
  private stopPromise: Promise<boolean> | null = null
  private port: number = 32123
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
    const status = { ...proxyStatusManager.getRunningStatus(), isRunning: this.isRunning(), port: this.port, host: this.host, connections: proxyStatusManager.getStatistics().activeConnections }
    for (const listener of this.statusListeners) listener(this.isRunning())
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send('proxy:statusChanged', status)
  }
  private setupMiddleware(): void {
    this.app.use(async (ctx, next) => {
      const origin = ctx.get('Origin')
      const desktopOrigin = process.env.ELECTRON_RENDERER_URL
      const allowed = !origin || origin === 'null' || (desktopOrigin && origin === new URL(desktopOrigin).origin)
      if (!allowed) { ctx.status = 403; ctx.body = { error: { code: 'origin_not_allowed', message: 'This browser origin cannot access the local proxy' } }; return }
      if (origin) { ctx.set('Access-Control-Allow-Origin', origin); ctx.vary('Origin') }
      ctx.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
      ctx.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-API-Key, X-Enable-Vision, X-Enable-Thinking, X-Reasoning-Effort, X-Web-Search, X-Deep-Research, X-DailyWorkMate-Model-Selection')
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
      if (isInternalProxyKey(ctx.get('Authorization').replace(/^Bearer /, ''))) { await next(); return }
      
      if (config.enableApiKey) {
        const authHeader = ctx.get('Authorization') || ''
        const providedKey = authHeader.startsWith('Bearer ') 
          ? authHeader.slice(7) 
          : (ctx.query.api_key as string) || ctx.get('X-API-Key')
        
        if (!providedKey) {
          ctx.status = 401
          ctx.body = {
            error: {
              message: 'API key is required',
              type: 'invalid_request_error',
              code: 'missing_api_key',
            },
          }
          return
        }
        
        const validKey = (config.apiKeys || []).find(
          k => k.key === providedKey && k.enabled
        )
        
        if (!validKey) {
          ctx.status = 401
          ctx.body = {
            error: {
              message: 'Invalid API key',
              type: 'invalid_request_error',
              code: 'invalid_api_key',
            },
          }
          return
        }
        
        storeManager.recordApiKeyUsage(validKey.id)
      }
      
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
          const failure = ctx.state.streamError || (disconnected ? 'Client disconnected before completion' : undefined)
          const failed = Boolean(failure) || ctx.status >= 400
          const body = ctx.state.responseLogBody || (ctx.body && typeof ctx.body === 'object' && !('pipe' in ctx.body) ? JSON.stringify(ctx.body) : '')
          storeManager.addRequestLog({
            timestamp: startTime, status: failed ? 'error' : 'success', statusCode: failure ? 502 : ctx.status,
            method: ctx.method, url: ctx.path, model: String(request?.model || ''),
            actualModel: selected?.actualModel, providerId: selected?.provider.id, providerName: selected?.provider.name,
            accountId: selected?.account.id, accountName: selected?.account.name,
            requestBody: request ? JSON.stringify(request) : undefined,
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

  /**
   * Start server
   */
  async start(port?: number, host?: string): Promise<boolean> {
    if (this.server) {
      return false
    }

    this.port = port || proxyStatusManager.getPort()
    this.host = host || proxyStatusManager.getHost()
    const config = storeManager.getConfig()
    if (!['127.0.0.1', 'localhost', '::1'].includes(this.host) && (!config.enableApiKey || !config.apiKeys.some(key => key.enabled))) {
      storeManager.addLog('error', 'Enable API key authentication before exposing the proxy to the network')
      return false
    }
    if (!Number.isInteger(this.port) || this.port < 1 || this.port > 65535) return false
    
    return new Promise((resolve) => {
      try {
        const server = this.app.listen(this.port, this.host, () => {
          sessionManager.initialize()
          const config = storeManager.getConfig()
          proxyStatusManager.updateConfig({ timeout: config.requestTimeout, retryCount: config.retryCount })
          proxyStatusManager.start()
          proxyStatusManager.setPort(this.port)
          proxyStatusManager.setHost(this.host)
          this.broadcastStatus()

          storeManager.addLog('info', `Proxy server started successfully, listening on ${this.host}:${this.port}`)

          resolve(true)
        })
        this.server = server

        server.on('connection', connection => {
          this.connections.add(connection)
          connection.once('close', () => this.connections.delete(connection))
        })

        server.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE') {
            storeManager.addLog('error', `Port ${this.port} is already in use`)
          } else {
            storeManager.addLog('error', `Server error: ${err.message}`)
          }
          if (this.server === server) {
            this.server = null
          }
          resolve(false)
        })

        server.on('close', () => {
          if (this.server === server) {
            this.server = null
          }
        })
      } catch (error) {
        storeManager.addLog('error', `Failed to start server: ${error instanceof Error ? error.message : 'Unknown error'}`)
        resolve(false)
      }
    })
  }

  /**
   * Stop server
   */
  async stop(): Promise<boolean> {
    if (this.stopPromise) {
      return this.stopPromise
    }

    if (!this.server) {
      return false
    }

    const server = this.server
    sessionManager.destroy()

    this.stopPromise = (async () => {
      try {
        await closeHttpServer(server, this.connections)
        if (this.server === server) {
          this.server = null
        }
        this.connections.clear()
        proxyStatusManager.stop()
    this.broadcastStatus()

        storeManager.addLog('info', 'Proxy server stopped')
        return true
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        storeManager.addLog('error', `Failed to stop server: ${message}`)
        return false
      } finally {
        this.stopPromise = null
      }
    })()

    return this.stopPromise
  }

  /**
   * Restart server
   */
  async restart(port?: number, host?: string): Promise<boolean> {
    await this.stop()
    return this.start(port, host)
  }

  /**
   * Check if server is running
   */
  isRunning(): boolean {
    return this.server !== null && proxyStatusManager.getRunningStatus().isRunning
  }

  /**
   * Get server port
   */
  getPort(): number {
    return this.port
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
    return proxyStatusManager.getRunningStatus()
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
