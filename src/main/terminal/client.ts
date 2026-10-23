import { spawn } from 'node:child_process'
import { request as httpRequest, type ClientRequest } from 'node:http'
import { readFile, mkdir, open } from 'node:fs/promises'
import path from 'node:path'
import type { TerminalManagerAPI, TerminalState } from '../../shared/terminal'
import type { TerminalContext } from './host'

interface HostInfo { protocol: number; port: number; token: string; pid: number }
export interface TerminalClientOptions {
  home: string; entry: string; helper: string; ptyModule: string; executable?: string
  /** Called with no models: the host runs only shells, so it never receives model credentials. */
  context: (models: string[]) => Promise<TerminalContext>
  /** Process liveness probe and how long to wait for a live but busy host; replaceable in tests. */
  alive?: (pid: number) => boolean
  busyHostWait?: number
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
/** A permission error still means the process exists. */
export function processAlive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}
export class TerminalClient {
  private info?: HostInfo
  private lease?: ClientRequest
  private connecting?: Promise<void>
  private cached?: TerminalState
  /** Context last sent to this host; an unchanged context needs no sync. */
  private synced = ''
  private closing = false
  constructor(private readonly options: TerminalClientOptions) {}
  private alive(pid: number) { return (this.options.alive || processAlive)(pid) }
  /** OpenCode runs in Work tabs owned by the main process; the host never runs it. Kept for callers. */
  openCodeBusy() { return false }
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
          try {
            if (response.statusCode === 503) throw Object.assign(new Error('Terminal host is stopping'), { code: 'ESTOPPING' })
            const data = JSON.parse(raw); if (response.statusCode !== 200 || data.error) throw new Error(data.error || 'Terminal connection failed'); resolve(data.result)
          } catch (error) { reject(error) }
        })
      })
      req.setTimeout(timeout, () => req.destroy(new Error('Terminal operation timed out')))
      req.once('error', reject); req.end(body)
    })
  }
  /**
   * Rejoin the host named in host.json. Only a host that is gone may be replaced: two live hosts would
   * both own sessions.json. A busy host gets a bounded retry, then a clear error.
   */
  private async attachExisting(): Promise<boolean> {
    let info: HostInfo
    try { info = await this.readInfo() }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.info('[Terminal] Replacing unreadable host descriptor:', message(error)); return false }
    this.info = info
    const deadline = Date.now() + (this.options.busyHostWait ?? 10000)
    while (true) {
      try { await this.request({ action: 'ping' }, 1500); return true }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED' || !this.alive(info.pid)) {
          console.info('[Terminal] Replacing stopped host:', message(error)); this.info = undefined; return false
        }
        if (Date.now() > deadline) {
          this.info = undefined
          throw new Error(`终端后台进程（PID ${info.pid}）仍在运行但没有响应，请稍后重试或在任务管理器中结束它。 / The terminal host (PID ${info.pid}) is running but not responding. Try again shortly, or end that process in Task Manager.`)
        }
        console.warn('[Terminal] Host is not responding yet; retrying:', message(error))
        await sleep(500)
      }
    }
  }
  /** Sync the host only when the folders or OpenCode installation changed; otherwise read state. */
  private async refreshState(force: boolean) {
    const context = await this.options.context([])
    const fingerprint = JSON.stringify(context)
    if (!force && fingerprint === this.synced) return this.cached = await this.request({ action: 'state' }) as TerminalState
    const state: TerminalState = await this.request({ action: 'sync', context })
    this.synced = fingerprint; this.cached = state
    return state
  }
  /** Resolves true when this call (re)connected, which already synced the host. */
  private async connect(): Promise<boolean> {
    if (this.closing) throw new Error('The application is closing its terminals')
    if (this.info && this.lease && !this.lease.destroyed) return false
    if (this.connecting) { await this.connecting; return true }
    const connection = (async () => {
      if (!(await this.attachExisting())) {
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
          try { this.info = await this.readInfo(); await this.request({ action: 'ping' }, 1000); break }
          catch (error) { if (Date.now() > end) throw new Error('Unable to start terminal host. See terminal/host.log for details.'); await sleep(100) }
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
      // A host may have been started or restarted by someone else: always send it the current context.
      this.synced = ''
      await this.refreshState(true)
    })()
    this.connecting = connection
    try { await connection } finally { if (this.connecting === connection) this.connecting = undefined }
    return true
  }
  async command(action: string, values: object = {}) {
    await this.connect()
    const result = await this.request({ action, ...values })
    if (result && Array.isArray(result.sessions)) this.cached = result
    return result
  }
  /** Push the current folders to the host, e.g. after authorization changes. */
  async synchronize(): Promise<TerminalState> { return await this.connect() ? this.cached! : this.refreshState(true) }
  /** Folder edits must not start an otherwise unused terminal host. The first connect gets fresh context. */
  async synchronizeIfConnected(): Promise<void> { if (this.info || this.connecting) await this.synchronize() }
  /** The Terminal panel's periodic refresh: state only, unless the context changed. */
  async refresh(): Promise<TerminalState> { return await this.connect() ? this.cached! : this.refreshState(false) }
  /**
   * Rejoin an existing host at startup. Saved tabs are loaded when the Terminal view first opens;
   * their presence must not launch shells (and user profiles) while the app is opening.
   */
  async neededAtStartup(): Promise<boolean> {
    try { this.info = await this.readInfo(); await this.request({ action: 'ping' }, 1500); return true }
    catch (error) { this.info = undefined; if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.info('[Terminal] No running host at startup:', message(error)) }
    return false
  }
  /** Stop the host and its shells. A host that is already gone counts as stopped, so quitting never waits on it. */
  async detach() {
    this.closing = true
    let stopped = false
    try {
      // A failed connection attempt has nothing to stop beyond what host.json names.
      if (this.connecting) await this.connecting.catch(error => console.warn('[Terminal] Detaching after a failed connection:', message(error)))
      if (!this.info) { stopped = true; return }
      const info = this.info
      const gone = (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ECONNREFUSED' && this.alive(info.pid)) return false
        console.info('[Terminal] Host already stopped:', message(error)); return true
      }
      try {
        // Also turn off retention in hosts started by a previous application version.
        const state: TerminalState = await this.request({ action: 'state' }, 15000)
        await this.request({ action: 'preferences', preferences: { ...state.preferences, keepRunningOnExit: false } }, 15000)
        await this.request({ action: 'detach' }, 60000)
      } catch (error) {
        // A host that is already stopping is awaited below like one that accepted the detach.
        if ((error as NodeJS.ErrnoException).code !== 'ESTOPPING') { if (gone(error)) { stopped = true; return } throw error }
      }
      const deadline = Date.now() + 15000
      while (true) {
        // Windows reports EPERM while host.json is being deleted; keep waiting until it is gone.
        try { if ((await this.readInfo()).token !== info.token) break }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') break; if (Date.now() > deadline) throw error }
        if (!this.alive(info.pid)) break
        if (Date.now() > deadline) throw new Error('Terminal host did not stop')
        await sleep(50)
      }
      stopped = true
    }
    finally {
      if (stopped) { this.lease?.destroy(); this.lease = undefined; this.info = undefined; this.synced = '' }
      this.closing = false
    }
  }
  api(pickDirectory: TerminalManagerAPI['pickDirectory']): TerminalManagerAPI {
    return { get: () => this.refresh(), create: input => this.command('create', { input }), select: id => this.command('select', { id }), close: id => this.command('close', { id }),
      restart: id => this.command('restart', { id }), poll: (id, cursor) => this.command('poll', { id, cursor }), write: (id, data) => this.command('write', { id, data }),
      resize: (id, cols, rows) => this.command('resize', { id, cols, rows }), savePreferences: preferences => this.command('preferences', { preferences }),
      saveLayout: (tabId, layout) => this.command('layout', { tabId, layout }), pickDirectory }
  }
}
