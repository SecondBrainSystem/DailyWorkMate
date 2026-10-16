import path from 'node:path'
import os from 'node:os'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile, rename, realpath, stat, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { DEFAULT_TERMINAL_PREFERENCES, validateTerminalCreate, validateTerminalPreferences, terminalId } from '../../shared/terminal'
import type { TerminalCreateInput, TerminalSession, TerminalPreferences, TerminalOutput, TerminalState, ShellKind } from '../../shared/terminal'
import type { WorkspaceGrant, WorkspaceGroup } from '../../shared/companion'
import type { ProxyConnection } from '../companion/opencodeConfig'
import type { ModelConnection } from '../../shared/modelConnection'
import { OpenCodeService } from '../companion/opencode'
import { OpenCodeTerminalService } from '../companion/terminal'
import { closeAllTerminalProcesses, closeTerminalProcess, terminalSpawner, type TerminalProcess } from '../companion/terminalProcess'
import { findPowerShell } from './shells'

export interface TerminalContext {
  workspaces: WorkspaceGrant[]; groups: WorkspaceGroup[]; persona: string; proxy?: ProxyConnection; executable: string
  /** Resolved by the Electron process; credentials remain in memory and are never saved with tabs. */
  modelConnections?: Record<string, ModelConnection>
  modelConnectionErrors?: Record<string, string>
}
interface Live { session: TerminalSession; output: string; cursor: number; resume: boolean; pty?: TerminalProcess; agent?: OpenCodeService; native?: OpenCodeTerminalService; cwdPending?: string; scope?: string }
interface Saved { version: 1; preferences: TerminalPreferences; activeId: string; sessions: Array<{ session: TerminalSession; output: string; resume: boolean }> }
const LIMIT = 1024 * 1024
const label: Record<ShellKind, string> = { powershell: 'PowerShell', cmd: 'CMD', wsl: 'WSL', opencode: 'OpenCode' }

export class TerminalHost {
  private sessions = new Map<string, Live>()
  private preferences = { ...DEFAULT_TERMINAL_PREFERENCES }
  private activeId = ''
  private context: TerminalContext | undefined
  private ready = false
  private saving: Promise<void> = Promise.resolve()
  private saveTimer?: ReturnType<typeof setTimeout>
  private shells: TerminalState['shells'] = []
  constructor(readonly home: string, private readonly helper: string, private readonly ptyModule: string) {}
  private file() { return path.join(this.home, 'sessions.json') }
  private access(context: TerminalContext) { return JSON.stringify({ workspaces: context.workspaces, groups: context.groups }) }
  async initialize() {
    await mkdir(this.home, { recursive: true })
    try {
      const raw = await readFile(this.file(), 'utf8')
      if (raw.length > 24 * LIMIT) throw new Error('Saved terminal data is too large')
      const saved = JSON.parse(raw) as Saved
      if (saved.version !== 1 || !Array.isArray(saved.sessions) || saved.sessions.length > 16) throw new Error('Invalid saved terminal sessions')
      this.preferences = validateTerminalPreferences(saved.preferences)
      for (const item of saved.preferences.restoreOnStartup ? saved.sessions : []) {
        const input = validateTerminalCreate(item.session)
        if (typeof item.resume !== 'boolean' || typeof item.output !== 'string' || !Number.isFinite(item.session.createdAt)) throw new Error('Invalid saved terminal session')
        if (this.sessions.has(input.id)) throw new Error('Duplicate saved terminal ID')
        const session: TerminalSession = { ...input, title: label[input.kind], createdAt: item.session.createdAt, status: 'exited', error: '',
          ...(input.opencode?.sessionId ? { sessionId: input.opencode.sessionId } : {}) }
        // A new host cannot restore a dead PTY's cursor, modes or alternate screen.
        // Background hosts retain their actual live output in memory instead.
        this.sessions.set(input.id, { session, output: '', cursor: 0, resume: item.resume })
      }
      this.activeId = this.sessions.has(saved.activeId) ? saved.activeId : this.sessions.keys().next().value || ''
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const system = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows'
    const windows = process.platform === 'win32'
    const wsl = path.join(system, 'System32', 'wsl.exe')
    let wslAvailable = false
    if (windows && existsSync(wsl)) {
      wslAvailable = await new Promise<boolean>(resolve => execFile(wsl, ['--list', '--quiet'], { windowsHide: true, timeout: 8000, encoding: 'buffer' }, (error, output) => {
        const text = output?.toString('utf16le').replace(/\0/g, '').trim()
        resolve(!error && !!text)
      }))
    }
    this.shells = [
      { kind: 'powershell', available: windows && !!findPowerShell(), reason: windows ? 'PowerShell is unavailable' : 'PowerShell requires Windows' },
      { kind: 'cmd', available: windows, reason: 'CMD requires Windows' },
      { kind: 'wsl', available: wslAvailable, reason: 'Install WSL and a Linux distribution first' },
      { kind: 'opencode', available: false, reason: 'Install OpenCode v2 and authorize a folder first' },
    ]
  }
  async sync(context: TerminalContext) {
    // Concurrent create requests may resolve different models before either tab exists in state().
    // Keep their in-memory connections until an explicit resolution failure invalidates that model.
    this.context = context.modelConnections ? {
      ...context,
      modelConnections: {
        ...Object.fromEntries(Object.entries(this.context?.modelConnections || {}).filter(([model]) => !Object.hasOwn(context.modelConnectionErrors || {}, model))),
        ...context.modelConnections,
      },
      modelConnectionErrors: {
        ...Object.fromEntries(Object.entries(this.context?.modelConnectionErrors || {}).filter(([model]) => !Object.hasOwn(context.modelConnections!, model))),
        ...context.modelConnectionErrors,
      },
    } : context
    this.shells = this.shells.map(shell => shell.kind === 'opencode' ? { ...shell, available: existsSync(context.executable) && context.workspaces.length > 0 } : shell)
    const scope = this.access(context)
    for (const live of this.sessions.values()) {
      let accessChanged = false
      if (live.native && live.scope !== scope) {
        await live.native.refreshAccess()
        accessChanged = !!live.native.poll(live.session.id, 0).accessChanged
        this.sessions.set(live.session.id, { ...live, scope })
      }
      if (live.native && accessChanged) {
        await this.stop(live.session.id)
        const current = this.sessions.get(live.session.id)
        if (current) this.sessions.set(live.session.id, { ...current, resume: false, session: { ...current.session, status: 'error', error: 'Workspace permissions changed. Reconnect to use the current permissions.' } })
      }
    }
    if (!this.ready) {
      this.ready = true
      if (this.preferences.restoreOnStartup) await Promise.all([...this.sessions.values()].filter(live => live.resume).map(live => this.start(live.session.id).catch(error => this.fail(live.session.id, error))))
    }
    return this.state()
  }
  state(): TerminalState {
    return { defaultDirectory: os.homedir(), preferences: { ...this.preferences }, sessions: [...this.sessions.values()].map(live => ({ ...live.session })), activeId: this.activeId, shells: this.shells.map(shell => ({ ...shell })) }
  }
  private live(id: string) {
    const live = this.sessions.get(terminalId(id))
    if (!live) throw new Error('Terminal was closed')
    return live
  }
  private fail(id: string, error: unknown) {
    const live = this.sessions.get(id)
    if (!live) return
    this.sessions.set(id, { ...live, resume: false, session: { ...live.session, status: 'error', error: error instanceof Error ? error.message : 'Unable to start terminal' } })
    this.scheduleSave()
  }
  async create(value: TerminalCreateInput) {
    const input = validateTerminalCreate(value)
    if (this.sessions.size >= 16) throw new Error('At most 16 terminals can be open')
    if (this.sessions.has(input.id)) throw new Error('Terminal already exists')
    const session: TerminalSession = { ...input, title: label[input.kind], status: 'starting', error: '', createdAt: Date.now() }
    this.sessions.set(input.id, { session, output: '', cursor: 0, resume: true })
    this.activeId = input.id
    try { await this.start(input.id) } catch (error) { this.fail(input.id, error) }
    await this.save()
    return this.state()
  }
  private async start(id: string) {
    const initial = this.live(id)
    if (initial.pty || initial.native) return
    if (!this.shells.find(shell => shell.kind === initial.session.kind)?.available) throw new Error(this.shells.find(shell => shell.kind === initial.session.kind)?.reason || 'Terminal is unavailable')
    const directory = await realpath(initial.session.directory)
    if (!(await stat(directory)).isDirectory()) throw new Error('Working directory is not a folder')
    if (this.sessions.get(id) !== initial) throw new Error('Terminal startup cancelled')
    this.sessions.set(id, { ...initial, resume: true, session: { ...initial.session, directory, status: 'starting', error: '' } })
    const spawn = terminalSpawner(this.helper, this.ptyModule)
    if (initial.session.kind === 'opencode') {
      if (!this.context || !initial.session.opencode) throw new Error('Select an authorized folder and model for OpenCode')
      const context = this.context
      // Grants and model settings are read when asked, not copied at start: revoking a folder must make the
      // running OpenCode server stale (staleAttachments compares against these), so the tab ends.
      const latest = () => this.context ?? context
      // Each terminal has its own guard/config/SQLite profile. Never rewrite another terminal's permissions.
      const storage = { home: path.join(this.home, 'opencode', id), get: async () => ({ settings: { persona: latest().persona }, workspaces: latest().workspaces, groups: latest().groups, messages: [] }) }
      const resolveConnection = context.modelConnections ? async (model: string) => {
        const current = latest()
        const connection = current.modelConnections?.[model]
        if (!connection) throw new Error(current.modelConnectionErrors?.[model] || 'Model connection is unavailable. Reconnect the application before starting OpenCode.')
        return connection
      } : undefined
      const agent = new OpenCodeService(storage as unknown as ConstructorParameters<typeof OpenCodeService>[0], () => {
        const proxy = latest().proxy
        if (!proxy) throw new Error('Model connection is unavailable. Reconnect the application before starting OpenCode.')
        return proxy
      }, context.executable, resolveConnection)
      const native = new OpenCodeTerminalService(agent, storage.home, () => spawn)
      const current = this.live(id)
      this.sessions.set(id, { ...current, agent, native, scope: this.access(context) })
      try {
        const opened = await native.open({ ...initial.session.opencode, terminalId: id, cols: initial.session.cols, rows: initial.session.rows })
        if (this.sessions.get(id)?.native !== native) { await native.close(); return }
        const live = this.live(id)
        this.sessions.set(id, { ...live, session: { ...live.session, status: 'running', sessionId: opened.sessionId, opencode: { ...live.session.opencode!, sessionId: opened.sessionId } } })
      } catch (error) { await native.close(); const live = this.sessions.get(id); if (live?.native === native) this.sessions.set(id, { ...live, native: undefined, agent: undefined }); throw error }
    } else {
      const system = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows'
      const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.startsWith('DAILYWORKMATE_TERMINAL_') && key !== 'ELECTRON_RUN_AS_NODE')), TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>
      let file: string, args: string[]
      if (initial.session.kind === 'powershell') {
        const powershell = findPowerShell()
        if (!powershell) throw new Error('PowerShell is unavailable')
        file = powershell.file
        const prompt = "$global:DailyWorkMateOriginalPrompt=$function:prompt; function global:prompt { $d=(Get-Location).Path; if($d -match '^[A-Za-z]:'){[Console]::Write([char]27+']7;'+([uri]$d).AbsoluteUri+[char]7)}; if($global:DailyWorkMateOriginalPrompt){& $global:DailyWorkMateOriginalPrompt}else{'PS '+$d+'> '} }"
        args = ['-NoLogo', '-NoExit', '-EncodedCommand', Buffer.from(prompt, 'utf16le').toString('base64')]
      } else if (initial.session.kind === 'cmd') {
        file = path.join(system, 'System32', 'cmd.exe'); args = ['/D', '/Q']
        env.PROMPT = '$E]7;file://localhost/$P$E\\$P$G'
      } else {
        file = path.join(system, 'System32', 'wsl.exe')
        const unc = directory.match(/^\\\\wsl(?:\.localhost|\$)\\([^\\]+)(.*)$/i)
        const distribution = unc ? ['--distribution', unc[1]] : []
        const startingDirectory = unc ? unc[2].replace(/\\/g, '/') || '/' : directory
        const rc = path.join(this.home, 'wsl-shell.bashrc')
        await writeFile(rc, 'if [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi\n_dailyworkmate_cwd() { local d="$PWD"; d=${d//%/%25}; d=${d//#/%23}; d=${d//\\?/%3F}; printf "\\033]7;file://%s%s\\007" "$WSL_DISTRO_NAME" "$d"; }\nPROMPT_COMMAND="_dailyworkmate_cwd${PROMPT_COMMAND:+; $PROMPT_COMMAND}"\n', { mode: 0o600 })
        const linuxRc = await new Promise<string>((resolve, reject) => execFile(file, [...distribution, '--exec', 'wslpath', '-a', rc], { windowsHide: true, timeout: 10000 }, (error, stdout) => error ? reject(new Error('Unable to prepare WSL shell: ' + error.message)) : resolve(stdout.trim())))
        args = [...distribution, '--cd', startingDirectory, '--exec', 'bash', '--rcfile', linuxRc, '-i']
      }
      if (!this.sessions.has(id)) throw new Error('Terminal startup cancelled')
      const pty = spawn(file, args, { name: 'xterm-256color', cols: initial.session.cols, rows: initial.session.rows, cwd: directory, env, useConptyDll: process.platform === 'win32' })
      const live = this.live(id)
      this.sessions.set(id, { ...live, pty, session: { ...live.session, status: 'running' } })
      pty.onData(data => this.receive(id, pty, data))
      pty.onExit(({ exitCode }) => {
        const current = this.sessions.get(id)
        if (current?.pty !== pty) return
        this.sessions.set(id, { ...current, pty: undefined, resume: false, session: { ...current.session, status: exitCode ? 'error' : 'exited', error: exitCode ? 'Terminal exited (code ' + exitCode + ')' : '' } })
        this.scheduleSave()
      })
    }
    this.scheduleSave()
  }
  private receive(id: string, pty: TerminalProcess, data: string) {
    const live = this.sessions.get(id)
    if (live?.pty !== pty) return
    const pending = (live.cwdPending || '') + data
    let directory = live.session.directory
    for (const match of pending.matchAll(/\x1b\]7;([^\x07\x1b]+)(?:\x07|\x1b\\)/g)) {
      try {
        if (live.session.kind === 'cmd' && match[1].startsWith('file://localhost/')) {
          const candidate = match[1].slice('file://localhost/'.length)
          if (!/[\0-\x1f]/.test(candidate) && path.isAbsolute(candidate)) directory = path.normalize(candidate)
          continue
        }
        const url = new URL(match[1].replace(/\\/g, '/'))
        if (url.protocol === 'file:') {
          const decoded = decodeURIComponent(url.pathname)
          const distribution = match[1].match(/^file:\/\/([^/]+)/)?.[1]
          const candidate = live.session.kind === 'wsl' && distribution ? '\\\\wsl.localhost\\' + distribution + decoded.replace(/\//g, '\\') : decoded.replace(/^\/([A-Za-z]:)/, '$1')
          if (!/[\0-\x1f]/.test(candidate) && path.isAbsolute(candidate)) directory = path.normalize(candidate)
        }
      } catch (error) { console.error('[Terminal] Invalid shell directory report:', error instanceof Error ? error.message : String(error)) }
    }
    this.sessions.set(id, { ...live, output: (live.output + data).slice(-LIMIT), cursor: live.cursor + data.length, cwdPending: pending.slice(-4096), session: { ...live.session, directory } })
    this.scheduleSave()
  }
  poll(id: string, cursor: number): TerminalOutput {
    let live = this.live(id)
    if (live.native) {
      const remote = live.native.poll(id, 0)
      const changed = remote.cursor !== live.cursor || remote.running !== (live.session.status === 'running') || remote.error !== live.session.error
      live = { ...live, output: remote.data, cursor: remote.cursor, resume: remote.running,
        session: { ...live.session, status: remote.error ? 'error' : remote.running ? 'running' : live.session.status === 'starting' ? 'starting' : 'exited', error: remote.error } }
      this.sessions.set(id, live); if (changed) this.scheduleSave()
    }
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Invalid terminal cursor')
    const start = live.cursor - live.output.length
    const reset = cursor > live.cursor || cursor < start
    return { data: live.output.slice(reset ? 0 : cursor - start), cursor: live.cursor, reset, session: { ...live.session } }
  }
  write(id: string, data: string) {
    const live = this.live(id)
    if (typeof data !== 'string' || data.length > 65536) throw new Error('Invalid terminal input')
    if (live.session.status !== 'running') throw new Error('Reconnect this terminal before typing')
    if (live.native) live.native.write(id, data); else live.pty?.write(data)
  }
  resize(id: string, cols: number, rows: number) {
    const live = this.live(id)
    validateTerminalCreate({ ...live.session, cols, rows })
    if (live.native) live.native.resize(id, cols, rows); else live.pty?.resize(cols, rows)
    this.sessions.set(id, { ...live, session: { ...live.session, cols, rows } }); this.scheduleSave()
  }
  select(id: string) { this.live(id); this.activeId = id; this.scheduleSave(); return this.state() }
  private async stop(id: string) {
    const live = this.live(id)
    this.sessions.set(id, { ...live, pty: undefined, native: undefined, agent: undefined, session: { ...live.session, status: 'exited' } })
    try { await closeTerminalProcess(live.pty); await live.native?.close() }
    catch (error) { this.sessions.set(id, live); throw error }
  }
  async close(id: string) {
    const live = this.live(id)
    await this.stop(id)
    this.sessions.delete(id)
    if (this.activeId === id) this.activeId = this.sessions.keys().next().value || ''
    await this.save()
    if (live.session.kind === 'opencode') {
      const root = path.resolve(this.home, 'opencode'), target = path.resolve(root, id)
      const relative = path.relative(root, target)
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid terminal profile path')
      try {
        const actualRoot = await realpath(root), actualTarget = await realpath(target)
        const actualRelative = path.relative(actualRoot, actualTarget)
        if (!actualRelative || actualRelative.startsWith('..') || path.isAbsolute(actualRelative)) throw new Error('Terminal profile is outside its data directory')
        await rm(target, { recursive: true, force: true })
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    await this.save(); return this.state()
  }
  async restart(id: string) {
    await this.stop(id)
    const live = this.live(id)
    this.sessions.set(id, { ...live, output: '', cursor: 0, cwdPending: '', resume: true })
    try { await this.start(id) } catch (error) { this.fail(id, error) }
    await this.save(); return this.state()
  }
  async setPreferences(value: TerminalPreferences) { this.preferences = validateTerminalPreferences(value); await this.save(); return this.state() }
  async detach() {
    await this.save()
    for (const live of [...this.sessions.values()]) await this.stop(live.session.id)
    await this.save(); return false
  }
  async shutdown() { for (const live of [...this.sessions.values()]) await this.stop(live.session.id); await closeAllTerminalProcesses(); await this.save() }
  refreshNative() { for (const live of this.sessions.values()) if (live.native && live.session.status !== 'starting') this.poll(live.session.id, live.cursor) }
  private scheduleSave() { if (!this.saveTimer) this.saveTimer = setTimeout(() => { this.saveTimer = undefined; void this.save().catch(error => console.error('[Terminal] Save failed:', error.message)) }, 1500) }
  async save() {
    clearTimeout(this.saveTimer); this.saveTimer = undefined
    for (const live of this.sessions.values()) if (live.native && live.session.status !== 'starting') this.poll(live.session.id, 0)
    clearTimeout(this.saveTimer); this.saveTimer = undefined
    const saved: Saved = { version: 1, preferences: { ...this.preferences }, activeId: this.activeId,
      sessions: [...this.sessions.values()].map(live => ({ session: { ...live.session }, output: '', resume: live.resume })) }
    const operation = this.saving.then(async () => {
      const temporary = this.file() + '.' + randomUUID() + '.tmp'
      await writeFile(temporary, JSON.stringify(saved), { mode: 0o600 }); await rename(temporary, this.file())
    })
    this.saving = operation.catch(error => console.error('[Terminal] Save failed:', error.message))
    return operation
  }
}
