import { spawn, type ChildProcess } from 'node:child_process'
import { stopChildProcess } from './processTree.ts'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { boundedText, type AgentInput, type AgentSnapshot, type AgentTool, type ClaudeCodeStatus, type TerminalInput, type TerminalSnapshot, type WorkspaceGrant, type WorkspaceGroup } from '../../shared/companion.ts'
import { proxyConnection, type ProxyConnection } from './opencodeConfig.ts'
import type { ModelConnection } from '../../shared/modelConnection'
import { workspaceAccess } from './workspaceGroups.ts'
import { closeTerminalProcess, type TerminalProcess, type TerminalSpawn } from './terminalProcess.ts'

/** How to start Claude Code: a native executable, or npm's script run by this app's own Node runtime. */
export interface ClaudeCodeLaunch { file: string; prefix: string[]; display: string; env?: Record<string, string> }

/**
 * Claude Code is not bundled (its license does not allow redistribution); use the user's install.
 * npm shims on Windows are batch files, so run their package directly: arguments must never be re-parsed by cmd.exe.
 */
export function findClaudeCode(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, exists: (file: string) => boolean = existsSync): ClaudeCodeLaunch | null {
  const windows = platform === 'win32'
  const home = env.USERPROFILE || env.HOME || os.homedir()
  const pathValue = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] || ''
  const explicit = env.DAILYWORKMATE_CLAUDE_PATH?.trim()
  const candidates = [
    ...(explicit ? [explicit] : []),
    ...pathValue.split(windows ? ';' : ':').filter(Boolean).flatMap(dir => windows ? [path.join(dir, 'claude.exe'), path.join(dir, 'claude.cmd')] : [path.join(dir, 'claude')]),
    path.join(home, '.local', 'bin', windows ? 'claude.exe' : 'claude'),
    ...(windows && env.APPDATA ? [path.join(env.APPDATA, 'npm', 'claude.cmd')] : []),
  ]
  for (const candidate of candidates) {
    if (!exists(candidate)) continue
    if (!windows || candidate.toLowerCase().endsWith('.exe')) return { file: candidate, prefix: [], display: candidate }
    const pkg = path.join(path.dirname(candidate), 'node_modules', '@anthropic-ai', 'claude-code')
    const native = path.join(pkg, 'bin', 'claude.exe')
    if (exists(native)) return { file: native, prefix: [], display: candidate }
    const script = path.join(pkg, 'cli.js')
    if (exists(script)) return { file: process.execPath, prefix: [script], display: candidate, env: { ELECTRON_RUN_AS_NODE: '1' } }
  }
  return null
}

const MODEL_VARIABLES = ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']
/**
 * Connect Claude Code to a native Messages endpoint or the internal compatibility service.
 * Every model role uses the chosen model, and an app-owned config folder keeps the user's own
 * Claude Code login, settings, hooks and history untouched.
 */
export function claudeCodeEnvironment(base: NodeJS.ProcessEnv, proxy: ProxyConnection | ModelConnection, model: string, configDir: string, launch?: ClaudeCodeLaunch): Record<string, string> {
  const connection: ModelConnection = 'baseURL' in proxy ? proxy : { ...proxyConnection(proxy), model, protocol: 'anthropic', direct: false }
  if (connection.protocol !== 'anthropic') throw new Error('Claude Code requires an Anthropic-compatible model connection')
  const { baseURL, apiKey } = connection
  const headers = Object.entries(connection.headers || {})
  if (headers.some(([name, value]) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n\0]/.test(value))) throw new Error('Invalid Claude Code model headers')
  const inherited = Object.fromEntries(Object.entries(base).filter(([key, value]) => value !== undefined
    && !/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDECODE$|CLAUDE_CONFIG_DIR$|ELECTRON_RUN_AS_NODE$)/i.test(key))) as Record<string, string>
  return {
    ...inherited, ...launch?.env,
    ANTHROPIC_BASE_URL: baseURL.replace(/\/v1\/?$/, ''),
    ...(connection.direct ? { ANTHROPIC_API_KEY: apiKey } : { ANTHROPIC_AUTH_TOKEN: apiKey }),
    ...(headers.length ? { ANTHROPIC_CUSTOM_HEADERS: headers.map(([name, value]) => name + ': ' + value).join('\n') } : {}),
    ...Object.fromEntries(MODEL_VARIABLES.map(name => [name, connection.model])),
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
  }
}

/** Claude Code keys its per-folder records by forward-slash paths, e.g. `C:/Users/me/project`. */
export const claudeProjectKey = (dir: string) => path.resolve(dir).replace(/\\/g, '/')
/**
 * Skip the theme/login walkthrough in the app-owned config folder, and record folders the user
 * already authorized in DailyWorkMate as trusted. Claude Code's own trust prompt defaults to "No, exit",
 * which closed Work tabs; project settings, hooks and MCP servers stay disabled by the launch flags.
 */
export async function prepareClaudeConfig(configDir: string, trusted: string[] = []) {
  await mkdir(configDir, { recursive: true })
  const file = path.join(configDir, '.claude.json')
  let config: Record<string, any> = {}
  try { config = JSON.parse(await readFile(file, 'utf8')) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Claude Code 配置文件无法读取 / Cannot read the Claude Code config: ' + file + ': ' + (error instanceof Error ? error.message : String(error)))
  }
  const projects: Record<string, any> = config.projects && typeof config.projects === 'object' ? config.projects : {}
  const keys = [...new Set(trusted.map(claudeProjectKey))]
  if (config.hasCompletedOnboarding === true && keys.every(key => projects[key]?.hasTrustDialogAccepted === true)) return
  const next = { theme: 'dark', ...config, hasCompletedOnboarding: true,
    projects: { ...projects, ...Object.fromEntries(keys.map(key => [key, { ...projects[key], hasTrustDialogAccepted: true }])) } }
  const temp = file + '.' + process.pid + '.' + randomUUID() + '.tmp'
  await writeFile(temp, JSON.stringify(next, null, 2))
  await rename(temp, file)
}

export interface ClaudeCodeScope {
  directory: string; grants: WorkspaceGrant[]
  /** Every folder in scope is editable; mixed groups run read only. */
  writable: boolean
  commands: boolean
}
const WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'EnterWorktree', 'ExitWorktree']
const COMMAND_TOOLS = ['Bash', 'PowerShell']
/** Folder permissions become hard tool removals; project settings and MCP servers in the folder are not loaded. */
export function claudeCodeArgs(options: { model: string; scope: ClaudeCodeScope; sessionId: string; resume: boolean; print: boolean; systemPrompt?: string }): string[] {
  const { scope } = options
  const denied = [...(scope.writable ? [] : WRITE_TOOLS), ...(scope.commands ? [] : COMMAND_TOOLS)]
  const extra = [...new Set(scope.grants.map(grant => grant.path).filter(dir => path.relative(dir, scope.directory) !== ''))]
  return [
    '--model', options.model,
    '--setting-sources', 'user', '--strict-mcp-config',
    ...(extra.length ? ['--add-dir', ...extra] : []),
    ...(denied.length ? ['--disallowedTools', denied.join(',')] : []),
    // Chat has nobody to answer prompts: writable workspaces accept edits and commands, as OpenCode chat does.
    ...(options.print ? ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      ...(scope.writable ? ['--permission-mode', 'acceptEdits'] : []),
      ...(scope.writable && scope.commands ? ['--allowedTools', COMMAND_TOOLS.join(',')] : [])] : []),
    ...(options.resume ? ['--resume', options.sessionId] : ['--session-id', options.sessionId]),
    ...(options.systemPrompt ? ['--append-system-prompt', options.systemPrompt] : []),
  ]
}

const sessionPrefix = (scope: string) => 'cc:' + createHash('sha256').update(scope).digest('hex').slice(0, 16) + ':'
/** Public session IDs carry their folder scope, so a session never moves to other folders. */
export function claudeSessionId(publicId: string, scope: string): string {
  if (!publicId.startsWith('cc:')) return ''
  const prefix = sessionPrefix(scope)
  if (!publicId.startsWith(prefix)) throw new Error('此会话的工作范围已变化。请新建会话。 / This session belongs to another workspace scope. Start a new conversation.')
  const id = publicId.slice(prefix.length)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new Error('Invalid Claude Code session')
  return id
}
async function transcriptExists(configDir: string, id: string) {
  try { return (await readdir(path.join(configDir, 'projects'))).some(project => existsSync(path.join(configDir, 'projects', project, id + '.jsonl'))) }
  catch { return false }
}

type Storage = { home: string; get: () => Promise<{ workspaces: WorkspaceGrant[]; groups?: WorkspaceGroup[] }> }
type ScopeInput = Pick<AgentInput, 'workspaceId' | 'groupId' | 'accessScope' | 'relativePath'>
async function resolveScope(storage: Storage, input: ScopeInput) {
  if (input.workspaceId === '') {
    if (input.groupId || input.relativePath || (input.accessScope && input.accessScope !== 'group')) throw new Error('Select a workspace before specifying a group or folder scope')
    const directory = path.join(storage.home, 'data', 'claude-code', 'chat-workspace')
    await mkdir(directory, { recursive: true })
    return { scope: { directory, grants: [], writable: false, commands: false }, sessionScope: 'chat', plainChat: true, group: undefined }
  }
  const saved = await storage.get()
  const { selected, grants, group, sessionScope } = await workspaceAccess(saved.workspaces, saved.groups || [], input)
  const writable = selected.writable && grants.every(grant => grant.writable)
  // Commands run as the user, so only whole editable folders get them (in the TUI each one is confirmed).
  const scope: ClaudeCodeScope = { directory: selected.path, grants, writable, commands: writable && (input.accessScope ?? 'group') === 'group' }
  return { scope, sessionScope, plainChat: false, group }
}
function workspaceInstructions(scope: ClaudeCodeScope, plainChat: boolean, groupName?: string) {
  if (plainChat) return 'No user workspace is connected. The current directory is an empty internal folder. If a request needs local files, ask the user to select a workspace in the chat interface. Do not claim you inspected files or completed actions without tool evidence.'
  return 'DailyWorkMate workspace. Current directory: ' + scope.directory + (groupName ? '\nWorkspace group: ' + groupName : '')
    + '\nAuthorized folders (path and permission): ' + JSON.stringify(scope.grants.map(grant => ({ path: grant.path, permission: grant.writable ? 'read and write' : 'READ ONLY' })))
    + (scope.writable ? '' : '\nEditing tools are disabled for this scope.') + (scope.commands ? '' : '\nShell commands are disabled for this scope.')
    + '\nInspect files with tools before answering questions about them. Only claim actions confirmed by tool output. Reply in the user\'s language.'
}
const killTree = stopChildProcess

const empty = (): AgentSnapshot => ({ sessionId: '', running: false, text: '', error: '', tools: [], permissions: [] })
const describeInput = (input: Record<string, unknown> | undefined) => {
  const value = input?.file_path ?? input?.path ?? input?.pattern ?? input?.command ?? input?.url ?? input?.description
  return typeof value === 'string' ? value.slice(0, 300) : ''
}
/** Collects one `--output-format stream-json` run into the chat's agent snapshot. */
export class ClaudeStreamState {
  private texts: string[] = []
  private partial = ''
  private tools: AgentTool[] = []
  phase: AgentSnapshot['phase']
  sessionId = ''
  result: { error: boolean; text: string } | null = null
  accept(event: any) {
    if (!event || typeof event !== 'object') return
    if (typeof event.session_id === 'string' && !this.sessionId) this.sessionId = event.session_id
    if (event.type === 'stream_event') {
      const inner = event.event
      if (inner?.type === 'content_block_start') {
        if (inner.content_block?.type === 'text') { this.partial = ''; this.phase = 'responding' }
        else if (inner.content_block?.type === 'thinking') this.phase = 'thinking'
        else if (inner.content_block?.type === 'tool_use') this.phase = 'tool'
      } else if (inner?.type === 'content_block_delta' && inner.delta?.type === 'text_delta' && typeof inner.delta.text === 'string') {
        this.partial += inner.delta.text; this.phase = 'responding'
      }
    } else if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) { this.texts.push(block.text); this.partial = '' }
        if (block?.type === 'tool_use' && typeof block.id === 'string' && !this.tools.some(tool => tool.id === block.id)) {
          this.tools.push({ id: block.id, name: String(block.name || 'tool'), status: 'running', title: describeInput(block.input) })
          this.phase = 'tool'
        }
      }
    } else if (event.type === 'user' && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block?.type !== 'tool_result') continue
        this.tools = this.tools.map(tool => tool.id === block.tool_use_id ? { ...tool, status: block.is_error ? 'error' : 'completed' } : tool)
      }
    } else if (event.type === 'result') {
      const text = typeof event.result === 'string' ? event.result : ''
      const failed = event.is_error === true || (typeof event.subtype === 'string' && event.subtype !== 'success')
      this.result = { error: failed, text: failed ? text || (Array.isArray(event.errors) ? event.errors.join('\n') : '') || String(event.subtype || 'Claude Code failed') : text }
      if (!failed && !this.texts.length && text.trim()) this.texts.push(text)
      this.partial = ''
    }
  }
  snapshot(): Pick<AgentSnapshot, 'text' | 'tools' | 'phase'> {
    return { text: [...this.texts, this.partial].filter(text => text.trim()).join('\n\n'), tools: this.tools.map(tool => ({ ...tool })), phase: this.phase }
  }
}

/** Chat turns run Claude Code headless (`-p` with stream-json); each turn resumes the same Claude session. */
export class ClaudeCodeAgent {
  private current = empty()
  private child: ChildProcess | null = null
  private attempt = 0
  private readonly storage: Storage
  private readonly getProxyConfig: () => ProxyConnection
  private readonly locate: () => ClaudeCodeLaunch | null
  private readonly resolveConnection?: (model: string) => Promise<ModelConnection>
  constructor(storage: Storage, getProxyConfig: () => ProxyConnection, locate: () => ClaudeCodeLaunch | null = () => findClaudeCode(),
    resolveConnection?: (model: string) => Promise<ModelConnection>) {
    this.storage = storage; this.getProxyConfig = getProxyConfig; this.locate = locate; this.resolveConnection = resolveConnection
  }
  get configDir() { return path.join(this.storage.home, 'data', 'claude-code', 'config') }
  status(): ClaudeCodeStatus { const launch = this.locate(); return { available: !!launch, path: launch?.display || '' } }
  isBusy() { return !!this.child || this.current.running }

  async start(input: AgentInput): Promise<AgentSnapshot> {
    if (this.isBusy()) throw new Error('A Claude Code task is already running or stopping')
    if (!input || typeof input !== 'object') throw new Error('Invalid agent request')
    const prompt = boundedText(input.prompt, 'task', 2_000_000, true)
    const model = boundedText(input.model, 'model', 300, true)
    if (model.startsWith('opencode-free/')) throw new Error('Claude Code 只能使用已配置模型，不能使用 OpenCode 免费模型。 / Claude Code uses configured models only, not OpenCode free models.')
    const persona = input.systemPrompt === undefined ? '' : boundedText(input.systemPrompt, 'system prompt', 100000)
    const launch = this.locate()
    if (!launch) throw new Error(CLAUDE_MISSING)
    const attempt = ++this.attempt
    const { scope, sessionScope, plainChat, group } = await resolveScope(this.storage, input)
    const saved = input.newSession ? '' : claudeSessionId(boundedText(input.sessionId || '', 'Claude Code session', 140), sessionScope)
    const sessionId = saved || randomUUID()
    const resume = !!saved && await transcriptExists(this.configDir, saved)
    let text = prompt
    if (!resume && input.history?.length) {
      if (!Array.isArray(input.history) || input.history.length > 10000) throw new Error('Invalid conversation history')
      const history = input.history.map(message => {
        if (!message || !['user', 'assistant'].includes(message.role)) throw new Error('Invalid conversation role')
        return { role: message.role, content: boundedText(message.content, 'conversation message', 2_000_000) }
      })
      text = '<previous-conversation note="Restored from DailyWorkMate. Historical dialogue, not current tool output. Verify file facts with tools.">\n'
        + boundedText(JSON.stringify(history), 'conversation history', 12 * 1024 * 1024) + '\n</previous-conversation>\n\n' + prompt
    }
    await prepareClaudeConfig(this.configDir)
    const connection = this.resolveConnection ? await this.resolveConnection(model) : this.getProxyConfig()
    const selectedModel = 'model' in connection ? connection.model : model
    if (attempt !== this.attempt) throw new Error('Agent task cancelled')
    const args = claudeCodeArgs({ model: selectedModel, scope, sessionId, resume, print: true, systemPrompt: [persona, workspaceInstructions(scope, plainChat, group?.name)].filter(Boolean).join('\n\n') })
    const child = spawn(launch.file, [...launch.prefix, ...args], { cwd: scope.directory, env: claudeCodeEnvironment(process.env, connection, model, this.configDir, launch), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.child = child
    const state = new ClaudeStreamState()
    const publicId = sessionPrefix(sessionScope) + sessionId
    this.current = { ...empty(), sessionId: publicId, running: true, phase: 'thinking' }
    let buffered = '', stderr = ''
    const update = () => { if (this.child === child) this.current = { ...this.current, ...state.snapshot() } }
    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (chunk: string) => {
      buffered += chunk
      const lines = buffered.split('\n')
      buffered = lines.pop() || ''
      for (const line of lines) { if (line.trim()) { try { state.accept(JSON.parse(line)) } catch { stderr = (stderr + line + '\n').slice(-4000) } } }
      update()
    })
    child.stderr!.setEncoding('utf8')
    child.stderr!.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000) })
    child.stdin!.on('error', () => {})
    child.stdin!.end(text)
    const finish = (error: string) => {
      if (this.child !== child) return
      this.child = null
      if (buffered.trim()) { try { state.accept(JSON.parse(buffered)) } catch { /* partial final line */ } }
      update()
      this.current = { ...this.current, running: false, phase: undefined, permissions: [], error }
    }
    child.once('error', error => finish('无法启动 Claude Code / Unable to start Claude Code: ' + error.message))
    child.once('close', code => {
      const result = state.result
      finish(result?.error ? 'Claude Code: ' + result.text.slice(0, 2000) : code && !result ? 'Claude Code exited (code ' + code + ')' + (stderr.trim() ? ': ' + stderr.trim().slice(-1500) : '') : '')
    })
    return structuredClone(this.current)
  }
  async poll(): Promise<AgentSnapshot> { return structuredClone(this.current) }
  async stop() {
    this.attempt++
    const child = this.child
    if (child) await killTree(child)
    if (this.child === child) this.child = null
    this.current = { ...this.current, running: false, phase: undefined, permissions: [] }
  }
  async reply(_id: string, _allow: boolean) { throw new Error('Claude Code chat does not ask for per-command approval') }
  dispose() { return this.stop() }
}
export const CLAUDE_MISSING = '未找到 Claude Code。请先安装（PowerShell：irm https://claude.ai/install.ps1 | iex，或 npm i -g @anthropic-ai/claude-code），然后重新打开助手。 / Claude Code was not found. Install it, then reopen the assistant.'

const OUTPUT_LIMIT = 2 * 1024 * 1024
interface Entry { pty: TerminalProcess | null; current: TerminalSnapshot; output: string; cursor: number; input: TerminalInput; access: string }
const MAX_CLAUDE_TERMINALS = 8
/** Interactive Claude Code in Work tabs. Commands and edits are confirmed inside Claude Code itself. */
export class ClaudeCodeTerminalService {
  private entries = new Map<string, Entry>()
  private readonly storage: Storage
  private readonly getProxyConfig: () => ProxyConnection
  private readonly loadPty: () => TerminalSpawn
  private readonly locate: () => ClaudeCodeLaunch | null
  private readonly resolveConnection?: (model: string) => Promise<ModelConnection>
  constructor(storage: Storage, getProxyConfig: () => ProxyConnection, loadPty: () => TerminalSpawn, locate: () => ClaudeCodeLaunch | null = () => findClaudeCode(),
    resolveConnection?: (model: string) => Promise<ModelConnection>) {
    this.storage = storage; this.getProxyConfig = getProxyConfig; this.loadPty = loadPty; this.locate = locate; this.resolveConnection = resolveConnection
  }
  get configDir() { return path.join(this.storage.home, 'data', 'claude-code', 'config') }
  has(id: string) { return this.entries.has(id) }
  busy() { return [...this.entries.values()].some(entry => entry.current.running) }

  async open(input: TerminalInput): Promise<TerminalSnapshot> {
    if (!input || typeof input !== 'object') throw new Error('Invalid terminal request')
    if (!Number.isInteger(input.cols) || !Number.isInteger(input.rows) || input.cols < 2 || input.cols > 500 || input.rows < 2 || input.rows > 250) throw new Error('Invalid terminal dimensions')
    const id = boundedText(input.terminalId ?? randomUUID(), 'terminal ID', 36, true)
    if (!/^[a-f0-9-]{32,36}$/.test(id)) throw new Error('Invalid terminal ID')
    if (this.entries.has(id)) throw new Error('This Claude Code terminal is already open')
    if (this.entries.size >= MAX_CLAUDE_TERMINALS) throw new Error(`最多同时打开 ${MAX_CLAUDE_TERMINALS} 个 Claude Code 标签。 / At most ${MAX_CLAUDE_TERMINALS} Claude Code tabs can be open at once.`)
    const model = boundedText(input.model, 'model', 300, true)
    if (model.startsWith('opencode-free/')) throw new Error('Claude Code 只能使用已配置模型。 / Claude Code uses configured models only.')
    if (!input.workspaceId) throw new Error('Select an authorized folder for Claude Code')
    const launch = this.locate()
    if (!launch) throw new Error(CLAUDE_MISSING)
    const entry: Entry = { pty: null, current: { id, sessionId: '', running: false, starting: true, data: '', cursor: 0, error: '', reset: false }, output: '', cursor: 0, input, access: '' }
    this.entries.set(id, entry)
    try {
      const { scope, sessionScope, group } = await resolveScope(this.storage, input)
      entry.access = JSON.stringify(scope)
      const saved = input.newSession ? '' : claudeSessionId(boundedText(input.sessionId || '', 'Claude Code session', 140), sessionScope)
      const sessionId = saved || randomUUID()
      const resume = !!saved && await transcriptExists(this.configDir, saved)
      await prepareClaudeConfig(this.configDir, [scope.directory, ...scope.grants.map(grant => grant.path)])
      const connection = this.resolveConnection ? await this.resolveConnection(model) : this.getProxyConfig()
      const selectedModel = 'model' in connection ? connection.model : model
      const spawnPty = this.loadPty()
      if (this.entries.get(id) !== entry) throw new Error('Terminal startup cancelled')
      const args = claudeCodeArgs({ model: selectedModel, scope, sessionId, resume, print: false, systemPrompt: workspaceInstructions(scope, false, group?.name) })
      const terminal = spawnPty(launch.file, [...launch.prefix, ...args], { name: 'xterm-256color', cols: input.cols, rows: input.rows, cwd: scope.directory, useConptyDll: process.platform === 'win32',
        env: { ...claudeCodeEnvironment(process.env, connection, model, this.configDir, launch), TERM: 'xterm-256color', COLORTERM: 'truecolor' } })
      entry.pty = terminal
      entry.current = { ...entry.current, sessionId: sessionPrefix(sessionScope) + sessionId, running: true, starting: false }
      terminal.onData(chunk => {
        if (this.entries.get(id) !== entry) return
        entry.output = (entry.output + chunk).slice(-OUTPUT_LIMIT)
        entry.cursor += chunk.length
      })
      terminal.onExit(({ exitCode }) => {
        if (entry.pty !== terminal) return
        entry.pty = null
        if (process.platform === 'win32') { try { terminal.kill() } catch { /* already released */ } }
        entry.current = { ...entry.current, running: false, starting: false, error: exitCode ? 'Claude Code exited (code ' + exitCode + ')' : '' }
      })
      return this.poll(id, 0)
    } catch (error) {
      if (this.entries.get(id) === entry) this.entries.delete(id)
      throw error
    }
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
    if (!entry.current.running || !entry.pty) throw new Error(entry.current.starting
      ? 'Claude Code 终端仍在启动，请稍候。 / Claude Code terminal is still starting; wait before typing.'
      : 'Claude Code 已退出，无法接回原进程。重新启动会创建新进程，先前任务不会自动继续。 / Claude Code has exited. Starting again creates a new process; the previous task will not resume automatically.')
    entry.pty.write(data)
  }
  resize(id: string, cols: number, rows: number) {
    const entry = this.entry(id)
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || cols > 500 || rows < 2 || rows > 250) throw new Error('Invalid terminal dimensions')
    entry.pty?.resize(cols, rows)
  }
  /** End tabs whose folders or permissions changed; each view reconnects under the current grants. */
  async refreshAccess() {
    for (const entry of this.entries.values()) {
      if (!entry.pty) continue
      const now = await resolveScope(this.storage, entry.input).then(result => JSON.stringify(result.scope), () => '')
      if (now === entry.access) continue
      const terminal = entry.pty
      entry.pty = null
      entry.current = { ...entry.current, running: false, starting: false, error: '', accessChanged: true }
      try { terminal.kill() } catch (error) { console.error('[Claude Code] End terminal after permission change:', error instanceof Error ? error.message : String(error)) }
    }
  }
  async close(id?: string) {
    const ids = id === undefined ? [...this.entries.keys()] : [boundedText(id, 'terminal ID', 36, true)]
    for (const key of ids) {
      const entry = this.entries.get(key)
      if (!entry) continue
      this.entries.delete(key)
      const terminal = entry.pty
      entry.pty = null
      await closeTerminalProcess(terminal)
    }
  }
}
