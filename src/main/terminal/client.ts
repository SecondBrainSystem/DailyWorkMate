import { spawn } from 'node:child_process'
import { request as httpRequest, type ClientRequest } from 'node:http'
import { readFile, mkdir, open } from 'node:fs/promises'
import path from 'node:path'
import type { TerminalManagerAPI, TerminalState } from '../../shared/terminal'
import type { TerminalContext } from './host'

interface HostInfo { protocol: number; port: number; token: string; pid: number }
export interface TerminalClientOptions { home: string; entry: string; helper: string; ptyModule: string; executable?: string; context: (models: string[]) => Promise<TerminalContext> }
export class TerminalClient {
  private info?: HostInfo
  private lease?: ClientRequest
  private connecting?: Promise<void>
  private cached?: TerminalState
  private pendingOpenCode = 0
  private modelConnectionsSupported = false
  private closing = false
  constructor(private readonly options: TerminalClientOptions) {}
  openCodeBusy() { return this.pendingOpenCode > 0 || !!this.cached?.sessions.some(session => session.kind === 'opencode' && ['starting', 'running'].includes(session.status)) }
  private async readInfo() {
    const raw = await readFile(path.join(this.options.home, 'host.json'), 'utf8')
    if (raw.length > 4096) throw new Error('Invalid terminal host descriptor')
    const info = JSON.parse(raw) as HostInfo
    if (info.protocol !== 1 || !Number.isInteger(info.port) || info.port < 1 || info.port > 65535 || !/^[a-f0-9]{64}$/.test(info.token) || !Number.isInteger(info.pid)) throw new Error('Invalid terminal host descriptor')
    return info
  }
  private request(value: object, timeout = 90000): Promise<any> {
    const info = this.info
    if (!info) throw new Error('Terminal host is unavailable')
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(value)
      const req = httpRequest({ hostname: '127.0.0.1', port: info.port, path: '/command', method: 'POST', headers: { Authorization: 'Bearer ' + info.token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => {
        let raw = ''
        response.setEncoding('utf8'); response.on('data', chunk => { raw += chunk; if (raw.length > 8 * 1024 * 1024) req.destroy(new Error('Terminal response too large')) })
        response.once('error', reject)
        response.once('end', () => {
          try { const data = JSON.parse(raw); if (response.statusCode !== 200 || data.error) throw new Error(data.error || 'Terminal connection failed'); resolve(data.result) } catch (error) { reject(error) }
        })
      })
      req.setTimeout(timeout, () => req.destroy(new Error('Terminal operation timed out')))
      req.once('error', reject); req.end(body)
    })
  }
  private async context(extraModels: string[] = []) {
    const state: TerminalState = await this.request({ action: 'state' })
    const models = [...new Set([...state.sessions.flatMap(session => session.opencode?.model ? [session.opencode.model] : []), ...extraModels])]
    return this.options.context(models)
  }
  private async connect() {
    if (this.closing) throw new Error('The application is closing its terminals')
    if (this.info && this.lease && !this.lease.destroyed) return
    if (this.connecting) return this.connecting
    const connection = (async () => {
      let existing = false
      try { this.info = await this.readInfo(); const capabilities = await this.request({ action: 'ping' }, 1500); this.modelConnectionsSupported = capabilities.modelConnections === true; existing = true }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.info('[Terminal] Replacing unavailable host:', error instanceof Error ? error.message : String(error)) }
      if (!existing) {
        await mkdir(this.options.home, { recursive: true })
        const log = await open(path.join(this.options.home, 'host.log'), 'a', 0o600)
        const child = spawn(this.options.executable || process.execPath, [this.options.entry], { detached: true, windowsHide: true,
          stdio: ['ignore', log.fd, log.fd], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DAILYWORKMATE_TERMINAL_HOME: this.options.home,
            DAILYWORKMATE_TERMINAL_HELPER: this.options.helper, DAILYWORKMATE_TERMINAL_PTY: this.options.ptyModule } })
        let launchError: Error | undefined
        child.once('error', error => { launchError = error }); child.unref(); await log.close()
        const end = Date.now() + 15000
        while (true) {
          if (launchError) throw launchError
          try { this.info = await this.readInfo(); const capabilities = await this.request({ action: 'ping' }, 1000); this.modelConnectionsSupported = capabilities.modelConnections === true; break }
          catch (error) { if (Date.now() > end) throw new Error('Unable to start terminal host. See terminal/host.log for details.'); await new Promise(resolve => setTimeout(resolve, 100)) }
        }
      }
      const info = this.info!
      await new Promise<void>((resolve, reject) => {
        const lease = httpRequest({ hostname: '127.0.0.1', port: info.port, path: '/lease', headers: { Authorization: 'Bearer ' + info.token } }, response => {
          if (response.statusCode !== 200) { lease.destroy(); reject(new Error('Unable to attach terminal host')); return }
          response.resume(); response.on('error', error => { if (this.lease === lease) console.error('[Terminal] Connection lost:', error.message) }); resolve()
        })
        lease.on('error', error => { reject(error); console.error('[Terminal] Lease:', error.message) }); lease.end(); this.lease = lease
      })
      this.cached = await this.request({ action: 'sync', context: await this.context() })
    })()
    this.connecting = connection
    try { await connection } finally { if (this.connecting === connection) this.connecting = undefined }
  }
  async command(action: string, values: object = {}) {
    await this.connect()
    const creatingOpenCode = action === 'create' && (values as { input?: { kind: string } }).input?.kind === 'opencode'
    if (creatingOpenCode) this.pendingOpenCode++
    let result: any
    try {
      if (creatingOpenCode || action === 'restart') {
        const model = creatingOpenCode
          ? (values as { input?: { opencode?: { model: string } } }).input?.opencode?.model
          : this.cached?.sessions.find(session => session.id === (values as { id?: string }).id)?.opencode?.model
        if (model && !model.startsWith('opencode-free/') && !this.modelConnectionsSupported) {
          throw new Error('后台终端仍在使用旧版本。请先结束并关闭保留的终端，再重新启动应用，以启用模型直连；当前任务未被停止。 / The retained terminal host is from an older version. Finish and close its terminals, then restart the application to enable direct model connections. Existing tasks were not stopped.')
        }
        this.cached = await this.request({ action: 'sync', context: await this.context(model ? [model] : []) })
      }
      result = await this.request({ action, ...values })
    } finally { if (creatingOpenCode) this.pendingOpenCode-- }
    if (result && Array.isArray(result.sessions)) this.cached = result
    if (action === 'poll' && result?.session && this.cached) this.cached = { ...this.cached, sessions: this.cached.sessions.map(session => session.id === result.session.id ? result.session : session) }
    return result
  }
  async synchronize() { await this.connect(); return this.command('sync', { context: await this.context() }) as Promise<TerminalState> }
  /**
   * The host process costs ~60 MB, so startup connects only to rejoin a host kept running in the
   * background or to restore saved tabs. Otherwise it starts when the Terminal view first needs it.
   */
  async neededAtStartup(): Promise<boolean> {
    try { this.info = await this.readInfo(); await this.request({ action: 'ping' }, 1500); return true }
    catch { this.info = undefined }
    try {
      const saved = JSON.parse(await readFile(path.join(this.options.home, 'sessions.json'), 'utf8'))
      return saved?.preferences?.restoreOnStartup === true && Array.isArray(saved.sessions) && saved.sessions.length > 0
    } catch { return false }
  }
  async detach() {
    this.closing = true
    let stopped = false
    try {
      if (this.connecting) await this.connecting
      if (!this.info) { stopped = true; return }
      // Also turn off retention in hosts started by a previous application version.
      const state: TerminalState | undefined = await this.request({ action: 'state' }).catch(error => {
        if (error.code === 'ECONNREFUSED') return undefined
        throw error
      })
      if (!state) { stopped = true; return }
      await this.request({ action: 'preferences', preferences: { ...state.preferences, keepRunningOnExit: false } })
      await this.request({ action: 'detach' }, 60000)
      const token = this.info.token
      const deadline = Date.now() + 15000
      while (true) {
        try { if ((await this.readInfo()).token !== token) break }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') break; throw error }
        if (Date.now() > deadline) throw new Error('Terminal host did not stop')
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      stopped = true
    }
    finally {
      if (stopped) { this.lease?.destroy(); this.lease = undefined; this.info = undefined }
      this.closing = false
    }
  }
  api(pickDirectory: TerminalManagerAPI['pickDirectory']): TerminalManagerAPI {
    return { get: () => this.synchronize(), create: input => this.command('create', { input }), select: id => this.command('select', { id }), close: id => this.command('close', { id }),
      restart: id => this.command('restart', { id }), poll: (id, cursor) => this.command('poll', { id, cursor }), write: (id, data) => this.command('write', { id, data }),
      resize: (id, cols, rows) => this.command('resize', { id, cols, rows }), savePreferences: preferences => this.command('preferences', { preferences }), pickDirectory }
  }
}
