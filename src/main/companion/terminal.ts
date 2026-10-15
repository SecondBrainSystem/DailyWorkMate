import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { terminalSpawner, type TerminalProcess, type TerminalSpawn } from './terminalProcess'
import { boundedText, type TerminalInput, type TerminalSnapshot } from '../../shared/companion'
import type { OpenCodeService } from './opencode'

const OUTPUT_LIMIT = 2 * 1024 * 1024
/** Each Work tab attaches to the guarded server for its folder scope; this caps the native clients. */
export const MAX_OPENCODE_TERMINALS = 8
export function terminalSize(cols: unknown, rows: unknown): { cols: number; rows: number } {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || Number(cols) < 2 || Number(cols) > 500 || Number(rows) < 2 || Number(rows) > 250) {
    throw new Error('Invalid terminal dimensions')
  }
  return { cols: Number(cols), rows: Number(rows) }
}

type TerminalAgent = Pick<OpenCodeService, 'prepareTerminal' | 'releaseTerminal' | 'dispose'> & Partial<Pick<OpenCodeService, 'staleAttachments' | 'cancelPreparation'>>
interface Entry {
  pty: TerminalProcess | null
  current: TerminalSnapshot
  output: string
  cursor: number
  /** Server attachment held by this client; released exactly once. */
  attachment: number | null
}

/** Native OpenCode TUIs (one per Work tab), each attached to the guarded local server for its scope. */
export class OpenCodeTerminalService {
  private entries = new Map<string, Entry>()
  constructor(private readonly agent: TerminalAgent, private readonly home: string,
    private readonly loadPty: () => TerminalSpawn = () => terminalSpawner()) {}

  async open(input: TerminalInput): Promise<TerminalSnapshot> {
    if (!input || typeof input !== 'object') throw new Error('Invalid terminal request')
    const size = terminalSize(input.cols, input.rows)
    const id = input.terminalId === undefined ? randomBytes(16).toString('hex') : boundedText(input.terminalId, 'terminal ID', 36, true)
    if (!/^[a-f0-9-]{32,36}$/.test(id)) throw new Error('Invalid terminal ID')
    if (this.entries.has(id)) throw new Error('This OpenCode terminal is already open')
    if (this.entries.size >= MAX_OPENCODE_TERMINALS) throw new Error(`最多同时打开 ${MAX_OPENCODE_TERMINALS} 个工作标签。 / At most ${MAX_OPENCODE_TERMINALS} work tabs can be open at once.`)
    const entry: Entry = { pty: null, current: { id, sessionId: '', running: false, data: '', cursor: 0, error: '', reset: false }, output: '', cursor: 0, attachment: null }
    this.entries.set(id, entry)
    try {
      const spawn = this.loadPty()
      const runtime = await this.agent.prepareTerminal(input)
      entry.attachment = runtime.attachment
      if (this.entries.get(id) !== entry) throw new Error('Terminal startup cancelled')
      const data = path.join(this.home, 'data', 'opencode-v2')
      const inherited = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined &&
        ['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL'].includes(key.toUpperCase()))) as Record<string, string>
      const terminal = spawn(runtime.executable, ['--server', runtime.address, '--session', runtime.remoteSessionId, runtime.directory], {
        name: 'xterm-256color', ...size, cwd: runtime.directory, useConptyDll: process.platform === 'win32',
        env: { ...inherited, TERM: 'xterm-256color', COLORTERM: 'truecolor',
          HOME: path.join(data, 'home'), USERPROFILE: path.join(data, 'home'),
          TEMP: path.join(data, 'tmp'), TMP: path.join(data, 'tmp'), TMPDIR: path.join(data, 'tmp'),
          XDG_CONFIG_HOME: path.join(data, 'config'), XDG_CACHE_HOME: path.join(data, 'cache'),
          XDG_DATA_HOME: path.join(data, 'data'), XDG_STATE_HOME: path.join(data, 'state'),
          OPENCODE_TEST_HOME: path.join(data, 'home'), OPENCODE_DISABLE_AUTOUPDATE: 'true',
          OPENCODE_CONFIG_PROJECT_DISABLE: 'true', OPENCODE_PASSWORD: runtime.password, OPENCODE_SERVER_PASSWORD: runtime.password,
        },
      })
      entry.pty = terminal
      entry.current = { ...entry.current, sessionId: runtime.sessionId, running: true }
      terminal.onData(chunk => {
        if (this.entries.get(id) !== entry) return
        entry.output = (entry.output + chunk).slice(-OUTPUT_LIMIT)
        entry.cursor += chunk.length
      })
      terminal.onExit(({ exitCode }) => {
        if (entry.pty !== terminal) return
        entry.pty = null
        // A naturally exited ConPTY client still owns its input pipe until kill releases it.
        if (process.platform === 'win32') {
          try { terminal.kill() }
          catch (error) { console.error('[Companion] Release terminal handles:', error instanceof Error ? error.message : String(error)) }
        }
        entry.current = { ...entry.current, running: false, error: exitCode ? 'OpenCode terminal exited (code ' + exitCode + ')' : '' }
        void this.release(entry)
      })
      return this.poll(id, 0)
    } catch (error) {
      if (this.entries.get(id) === entry) {
        entry.current = { ...entry.current, running: false, error: error instanceof Error ? error.message : 'Unable to open OpenCode terminal' }
      }
      // A failed preparation stops its own idle server; other tabs keep theirs.
      if (entry.attachment !== null) await this.release(entry)
      throw error
    }
  }

  private async release(entry: Entry) {
    const attachment = entry.attachment
    entry.attachment = null
    if (attachment !== null) await this.agent.releaseTerminal(attachment)
  }
  private entry(id: string) {
    boundedText(id, 'terminal ID', 36, true)
    const entry = this.entries.get(id)
    if (!entry) throw new Error('Terminal is no longer active')
    return entry
  }
  poll(id: string, cursor: number): TerminalSnapshot {
    const entry = this.entry(id)
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > entry.cursor) throw new Error('Invalid terminal output cursor')
    const start = entry.cursor - entry.output.length
    return { ...entry.current, cursor: entry.cursor, reset: cursor < start, data: entry.output.slice(Math.max(0, cursor - start)) }
  }
  write(id: string, data: string) {
    const entry = this.entry(id)
    if (typeof data !== 'string' || data.length > 65536) throw new Error('Invalid terminal input')
    if (!entry.current.running || !entry.pty) throw new Error('Terminal has exited; reconnect to continue')
    entry.pty.write(data)
  }
  resize(id: string, cols: number, rows: number) {
    const entry = this.entry(id)
    const size = terminalSize(cols, rows)
    entry.pty?.resize(size.cols, size.rows)
  }
  /**
   * End the tabs whose folder permissions changed. They stay listed with `accessChanged`,
   * so each view reconnects under the current permissions; other tabs keep running.
   */
  async refreshAccess() {
    const stale = await this.agent.staleAttachments?.() ?? new Set<number>()
    const ended = [...this.entries.values()].filter(entry => entry.attachment !== null && stale.has(entry.attachment))
    for (const entry of ended) {
      const terminal = entry.pty
      entry.pty = null
      entry.current = { ...entry.current, running: false, error: '', accessChanged: true }
      try { terminal?.kill() }
      catch (error) { console.error('[Companion] End terminal after permission change:', error instanceof Error ? error.message : String(error)) }
    }
    await Promise.all(ended.map(entry => this.release(entry)))
  }

  /** Close one Work tab, or every tab (and every server) when no ID is given. */
  async close(id?: string) {
    if (id !== undefined) {
      boundedText(id, 'terminal ID', 36, true)
      // An old React effect must never close a replacement terminal.
      const entry = this.entries.get(id)
      if (!entry) return
      this.entries.delete(id)
      if (!entry.pty) this.agent.cancelPreparation?.(id)
      const terminal = entry.pty
      entry.pty = null
      try { terminal?.kill() }
      finally { await this.release(entry) }
      return
    }
    const entries = [...this.entries.values()]
    this.entries.clear()
    try { for (const entry of entries) { const terminal = entry.pty; entry.pty = null; entry.attachment = null; terminal?.kill() } }
    finally { await this.agent.dispose() }
  }
}
