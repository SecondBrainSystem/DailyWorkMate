import path from 'node:path'
import os from 'node:os'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile, rename, realpath, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { DEFAULT_TERMINAL_PREFERENCES, validateTerminalCreate, validateTerminalPreferences, terminalId } from '../../shared/terminal'
import type { TerminalCreateInput, TerminalSession, TerminalPreferences, TerminalOutput, TerminalState, ShellKind } from '../../shared/terminal'
import type { WorkspaceGrant, WorkspaceGroup } from '../../shared/companion'
import type { ProxyConnection } from '../companion/opencodeConfig'
import type { ModelConnection } from '../../shared/modelConnection'
import { closeAllTerminalProcesses, closeTerminalProcess, closeTerminalProcesses, terminalSpawner, type TerminalProcess } from '../companion/terminalProcess'
import { appendOutput, emptyOutput, readOutput, type OutputBuffer } from './outputBuffer'
import { findPowerShell } from './shells'
import { MAX_PANES, normalizeTabs, panesOf, removePane, siblingPane, splitPane, tabOf, validateLayout, type TerminalTab } from '../../shared/terminalTabs'

export interface TerminalContext {
  workspaces: WorkspaceGrant[]; groups: WorkspaceGroup[]; persona: string; executable: string
  /** Accepted from older callers and ignored: OpenCode runs in Work tabs owned by the main process, never in this host. */
  proxy?: ProxyConnection
  modelConnections?: Record<string, ModelConnection>
  modelConnectionErrors?: Record<string, string>
}
interface Live { session: TerminalSession; output: OutputBuffer; resume: boolean; pty?: TerminalProcess; cwdPending?: string }
// `tabs` is optional: files from before split panes load as one pane per tab.
interface Saved { version: 1; preferences: TerminalPreferences; activeId: string; sessions: Array<{ session: TerminalSession; output: string; resume: boolean }>; tabs?: TerminalTab[] }
const LIMIT = 1024 * 1024
const label: Record<ShellKind, string> = { powershell: 'PowerShell', cmd: 'CMD', wsl: 'WSL', opencode: 'OpenCode' }
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

export class TerminalHost {
  private sessions = new Map<string, Live>()
  private tabs: TerminalTab[] = []
  private preferences = { ...DEFAULT_TERMINAL_PREFERENCES }
  private activeId = ''
  private ready = false
  private saving: Promise<void> = Promise.resolve()
  private saveTimer?: ReturnType<typeof setTimeout>
  private shells: TerminalState['shells'] = []
  constructor(readonly home: string, private readonly helper: string, private readonly ptyModule: string) {}
  private file() { return path.join(this.home, 'sessions.json') }
  async initialize() {
    await mkdir(this.home, { recursive: true })
    await this.restoreSaved()
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
      // Listed so the Terminal panel can route OpenCode to a Work tab; the host itself never starts it.
      { kind: 'opencode', available: false, reason: 'Install OpenCode v2 and authorize a folder first' },
    ]
  }
  /** One damaged record or file must never keep the host (and every terminal) from starting. */
  private async restoreSaved() {
    let raw: string
    try { raw = await readFile(this.file(), 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    let saved: Saved
    try {
      if (raw.length > 24 * LIMIT) throw new Error('Saved terminal data is too large')
      saved = JSON.parse(raw) as Saved
      if (!saved || saved.version !== 1 || !Array.isArray(saved.sessions)) throw new Error('Invalid saved terminal sessions')
      this.preferences = validateTerminalPreferences(saved.preferences)
    } catch (error) {
      // Keep the unreadable file for inspection instead of overwriting it on the next save.
      const backup = this.file() + '.' + new Date().toISOString().replace(/[:.]/g, '-') + '.bak'
      await rename(this.file(), backup)
      console.error('[Terminal host] Saved terminals were unreadable and moved to ' + backup + ':', message(error))
      return
    }
    const sessions = new Map<string, Live>()
    for (const [index, item] of (this.preferences.restoreOnStartup ? saved.sessions : []).entries()) {
      try {
        if (sessions.size >= 16) throw new Error('At most 16 terminals can be restored')
        const { split: _split, ...input } = validateTerminalCreate(item?.session)
        if (typeof item.resume !== 'boolean' || !Number.isFinite(item.session.createdAt)) throw new Error('Invalid saved terminal session')
        if (sessions.has(input.id)) throw new Error('Duplicate saved terminal ID')
        if (input.kind === 'opencode') { console.info('[Terminal host] Dropped legacy OpenCode tab ' + input.id + '; OpenCode now opens in Work tabs.'); continue }
        // A new host cannot restore a dead PTY's cursor, modes or alternate screen.
        sessions.set(input.id, { session: { ...input, title: label[input.kind], createdAt: item.session.createdAt, status: 'exited', error: '' }, output: emptyOutput(), resume: item.resume })
      } catch (error) { console.error('[Terminal host] Skipped saved terminal #' + index + ':', message(error)) }
    }
    const { tabs, problems } = normalizeTabs([...sessions.keys()], saved.tabs)
    for (const problem of problems) console.error('[Terminal host] Restored terminal layout without saved ' + problem)
    this.sessions = sessions
    this.activeId = sessions.has(saved.activeId) ? saved.activeId : tabs[0]?.focused || ''
    this.tabs = tabs.map(tab => panesOf(tab.layout).includes(this.activeId) ? { ...tab, focused: this.activeId } : tab)
  }
  async sync(context: TerminalContext) {
    if (!context || !Array.isArray(context.workspaces) || typeof context.executable !== 'string') throw new Error('Invalid terminal context')
    const openCode = !!context.executable && existsSync(context.executable) && context.workspaces.length > 0
    this.shells = this.shells.map(shell => shell.kind === 'opencode' ? { ...shell, available: openCode } : shell)
    if (!this.ready) {
      this.ready = true
      if (this.preferences.restoreOnStartup) await Promise.all([...this.sessions.values()].filter(live => live.resume).map(live => this.start(live.session.id).catch(error => this.fail(live.session.id, error))))
    }
    return this.state()
  }
  state(): TerminalState {
    return { defaultDirectory: os.homedir(), preferences: { ...this.preferences }, sessions: [...this.sessions.values()].map(live => ({ ...live.session })), activeId: this.activeId, shells: this.shells.map(shell => ({ ...shell })), tabs: this.tabs }
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
    const { split, ...input } = validateTerminalCreate(value)
    if (input.kind === 'opencode') throw new Error('OpenCode 请在“工作”标签中打开。 / OpenCode opens in a Work tab.')
    if (this.sessions.size >= 16) throw new Error('At most 16 terminals can be open')
    if (this.sessions.has(input.id)) throw new Error('Terminal already exists')
    const target = split && tabOf(this.tabs, split.beside)
    if (split && !target) throw new Error('The pane to split was closed')
    if (target && panesOf(target.layout).length >= MAX_PANES) throw new Error('At most ' + MAX_PANES + ' panes fit in one tab')
    const session: TerminalSession = { ...input, title: label[input.kind], status: 'starting', error: '', createdAt: Date.now() }
    this.sessions.set(input.id, { session, output: emptyOutput(), resume: true })
    // A new tab is identified by its first session's ID.
    this.tabs = split && target ? this.tabs.map(tab => tab === target ? { ...tab, layout: splitPane(tab.layout, split.beside, input.id, split.direction), focused: input.id } : tab)
      : [...this.tabs, { id: input.id, layout: { pane: input.id }, focused: input.id }]
    this.activeId = input.id
    try { await this.start(input.id) } catch (error) { this.fail(input.id, error) }
    await this.save()
    return this.state()
  }
  private async start(id: string) {
    const initial = this.live(id)
    if (initial.pty) return
    if (!this.shells.find(shell => shell.kind === initial.session.kind)?.available) throw new Error(this.shells.find(shell => shell.kind === initial.session.kind)?.reason || 'Terminal is unavailable')
    if (initial.session.kind === 'opencode') throw new Error('OpenCode opens in a Work tab')
    const directory = await realpath(initial.session.directory)
    if (!(await stat(directory)).isDirectory()) throw new Error('Working directory is not a folder')
    if (this.sessions.get(id) !== initial) throw new Error('Terminal startup cancelled')
    this.sessions.set(id, { ...initial, resume: true, session: { ...initial.session, directory, status: 'starting', error: '' } })
    const spawn = terminalSpawner(this.helper, this.ptyModule)
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
      } catch (error) { console.error('[Terminal] Invalid shell directory report:', message(error)) }
    }
    const moved = directory !== live.session.directory
    this.sessions.set(id, { ...live, output: appendOutput(live.output, data, LIMIT), cwdPending: pending.slice(-4096), session: moved ? { ...live.session, directory } : live.session })
    // Output is never saved; only a directory change alters sessions.json.
    if (moved) this.scheduleSave()
  }
  poll(id: string, cursor: number): TerminalOutput {
    const live = this.live(id)
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Invalid terminal cursor')
    const { data, reset } = readOutput(live.output, cursor, LIMIT)
    return { data, cursor: live.output.cursor, reset, session: { ...live.session } }
  }
  write(id: string, data: string) {
    const live = this.live(id)
    if (typeof data !== 'string' || data.length > 65536) throw new Error('Invalid terminal input')
    if (live.session.status !== 'running') throw new Error('Reconnect this terminal before typing')
    live.pty?.write(data)
  }
  resize(id: string, cols: number, rows: number) {
    const live = this.live(id)
    validateTerminalCreate({ ...live.session, cols, rows })
    live.pty?.resize(cols, rows)
    this.sessions.set(id, { ...live, session: { ...live.session, cols, rows } }); this.scheduleSave()
  }
  select(id: string) {
    this.live(id); this.activeId = id
    this.tabs = this.tabs.map(tab => tab.focused !== id && panesOf(tab.layout).includes(id) ? { ...tab, focused: id } : tab)
    this.scheduleSave(); return this.state()
  }
  /** Divider positions only: the tab must still hold exactly the same panes. */
  saveLayout(tabId: string, value: unknown) {
    const tab = this.tabs.find(item => item.id === tabId)
    if (!tab) throw new Error('Terminal tab was closed')
    const layout = validateLayout(value)
    if ([...panesOf(layout)].sort().join() !== [...panesOf(tab.layout)].sort().join()) throw new Error('Terminal panes changed; try again')
    this.tabs = this.tabs.map(item => item === tab ? { ...item, layout } : item)
    this.scheduleSave(); return this.state()
  }
  private async stop(id: string) {
    const live = this.live(id)
    this.sessions.set(id, { ...live, pty: undefined, session: { ...live.session, status: 'exited' } })
    try { await closeTerminalProcess(live.pty) }
    catch (error) { this.sessions.set(id, live); throw error }
  }
  /** Stops every shell in parallel; `resume` stays set so the next start can restore these tabs. */
  private async stopAll() {
    const running = [...this.sessions.values()].filter(live => live.pty)
    for (const live of running) this.sessions.set(live.session.id, { ...live, pty: undefined, session: { ...live.session, status: 'exited' } })
    await closeTerminalProcesses(running.map(live => live.pty))
  }
  async close(id: string) {
    await this.stop(id)
    this.sessions.delete(id)
    // The sibling takes over the closed pane's area and focus; the last pane closes its tab.
    const owner = tabOf(this.tabs, id)
    const layout = owner && removePane(owner.layout, id)
    const replacement = owner && layout ? { ...owner, layout, focused: owner.focused === id ? siblingPane(owner.layout, id) || panesOf(layout)[0] : owner.focused } : undefined
    this.tabs = this.tabs.flatMap(tab => tab !== owner ? [tab] : replacement ? [replacement] : [])
    if (this.activeId === id) this.activeId = replacement?.focused || this.tabs[0]?.focused || ''
    await this.save(); return this.state()
  }
  async restart(id: string) {
    await this.stop(id)
    const live = this.live(id)
    this.sessions.set(id, { ...live, output: emptyOutput(), cwdPending: '', resume: true })
    try { await this.start(id) } catch (error) { this.fail(id, error) }
    await this.save(); return this.state()
  }
  async setPreferences(value: TerminalPreferences) { this.preferences = validateTerminalPreferences(value); await this.save(); return this.state() }
  /** Terminals never outlive the application: the last client leaving ends every shell. */
  async detach() { try { await this.stopAll() } finally { await this.save() } }
  async shutdown() {
    const failures: unknown[] = []
    try { await this.stopAll() } catch (error) { failures.push(error) }
    // Also retries shells whose first stop failed, and processes from startups that did not finish.
    try { await closeAllTerminalProcesses() } catch (error) { failures.push(error) }
    await this.save()
    if (failures.length) throw new AggregateError(failures, 'Terminal processes did not stop')
  }
  private scheduleSave() { if (!this.saveTimer) this.saveTimer = setTimeout(() => { this.saveTimer = undefined; void this.save().catch(error => console.error('[Terminal] Save failed:', error.message)) }, 1500) }
  async save() {
    clearTimeout(this.saveTimer); this.saveTimer = undefined
    const saved: Saved = { version: 1, preferences: { ...this.preferences }, activeId: this.activeId,
      sessions: [...this.sessions.values()].map(live => ({ session: { ...live.session }, output: '', resume: live.resume })), tabs: this.tabs }
    const operation = this.saving.then(async () => {
      const temporary = this.file() + '.' + randomUUID() + '.tmp'
      await writeFile(temporary, JSON.stringify(saved), { mode: 0o600 }); await rename(temporary, this.file())
    })
    this.saving = operation.catch(error => console.error('[Terminal] Save failed:', error.message))
    return operation
  }
}
