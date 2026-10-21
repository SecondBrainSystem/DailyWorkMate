import { spawn, type ChildProcess } from 'node:child_process'
import { stopChildProcess } from './processTree'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import path from 'node:path'
import { createServer } from 'node:net'
import axios from 'axios'
import { boundedText } from '../../shared/companion.ts'
import type { AgentInput, AgentSnapshot, TerminalInput, WorkspaceGrant, WorkspaceGroup } from '../../shared/companion'
import type { ModelConnection } from '../../shared/modelConnection'
import { proxyConnection, type ProxyConnection } from './opencodeConfig.ts'
import { buildOpenCodeV2Config } from './opencodeV2Config'
import { OpenCodeV2Client, type OpenCodeV2EventSubscription, type OpenCodeV2LiveEvent } from './opencodeV2'
import { installWorkspaceGuardV2 } from './workspaceGuardV2'
import type { CompanionStorage } from './storage'
import { managedRuntimeExecutable, rollbackManagedRuntime } from './runtimeUpdates'
import { isOpenCodeFreeModel, resolveOpenCodeFreeModel, type OpenCodeFreeModel } from './opencodeModels'
import { workspaceAccess, workspaceRemoteSession, workspaceSessionPrefix } from './workspaceGroups'
import { staleProcessesReaped, trackProcess } from './processRegistry'

interface RemotePart { id: string; type: string; text?: string; tool?: string; state?: { status?: string; title?: string; input?: unknown; error?: string } }
interface RemoteMessage { info: { id: string; role: string; error?: { name?: string; data?: { message?: string } } }; parts: RemotePart[] }
interface LiveText { messageId: string; ordinal: number; text: string; complete: boolean }
type ScopeInput = Pick<AgentInput, 'workspaceId' | 'groupId' | 'accessScope' | 'relativePath'>
/** Chat turns and Work tabs start servers independently; each cancels only its own startups. */
type Owner = 'agent' | 'terminal'
interface ShellPolicy { allowShell: boolean; autoApproveCommands: boolean }
/** One guarded `opencode serve` process. Every folder scope and model gets its own. */
interface Server {
  key: string
  owner: Owner
  modelID: string
  /** The grants this server enforces; when the saved ones differ, its clients are stale. */
  access: string
  input: ScopeInput
  autoApproveCommands: boolean
  child: ChildProcess | null
  address: string
  password: string
  client: OpenCodeV2Client | null
  validated: boolean
  /** Native clients attached to this server; holds count startups that are about to use it. */
  attachments: Set<number>
  holds: number
  /** Set when folder permissions changed; it never takes new clients. */
  retired: boolean
  exited: Promise<boolean>
}
const empty = (): AgentSnapshot => ({ sessionId: '', running: false, text: '', error: '', tools: [], permissions: [] })
// Servers may run side by side in one profile, but a new one must not open its SQLite
// database while another process of that profile (from any service) is being killed.
const closingProcesses = new Map<string, Set<Promise<boolean>>>()
const closingIn = (home: string) => [...(closingProcesses.get(home) || [])]
const accessKey = (grants: WorkspaceGrant[], selected: WorkspaceGrant, allowShell: boolean, autoApproveCommands = false) => JSON.stringify({ allowShell, autoApproveCommands,
  selected: [selected.id, selected.path, selected.writable], grants: grants.map(grant => [grant.id, grant.path, grant.writable]).sort() })
/**
 * Commands run with the user's rights and can reach every folder, so chat (which has nobody to
 * approve each one) runs them only when every folder in scope is writable, as Claude Code does.
 * Work tabs ask in their TUI before each command.
 */
export function shellPolicy(owner: Owner, input: ScopeInput, grants: WorkspaceGrant[]): ShellPolicy {
  const scoped = input.workspaceId !== '' && input.accessScope !== 'folder'
  if (owner === 'terminal') return { allowShell: scoped, autoApproveCommands: false }
  const allowShell = scoped && grants.length > 0 && grants.every(grant => grant.writable)
  return { allowShell, autoApproveCommands: allowShell }
}
const joinText = (order: readonly string[], parts: ReadonlyMap<string, readonly string[]>) => order.flatMap(id => parts.get(id) || []).join('\n')
export interface OpenCodeServiceOptions {
  /** Minimum milliseconds between remote refreshes while a chat turn runs; tests use 0. */
  refreshIntervals?: Partial<{ messages: number; live: number; permissions: number }>
}

export function runtimeExecutable(home: string): string {
  const directory = path.join(home, 'runtime', 'opencode-v2', 'node_modules')
  // npm's postinstall chooses a CPU-compatible native executable on every OS.
  // The pinned package uses this filename on Unix as well as Windows.
  return path.join(directory, '@opencode', 'cli', 'bin', 'opencode.exe')
}

export class OpenCodeService {
  // Servers share one profile (session database), so any session can reopen in a matching scope.
  private servers = new Map<string, Server>()
  private failedChildren = new Set<ChildProcess>()
  private attachmentServers = new Map<number, Server>()
  private agentServer: Server | null = null
  private current = empty()
  /** Chat and Work tabs have separate startup state: neither blocks or cancels the other. */
  private agentStarting = false
  private terminalPreparing = false
  private stopping = false
  private agentAttempt = 0
  private terminalAttempt = 0
  /** Startups in progress by server key, so two owners never start or replace the same server twice. */
  private launches = new Map<string, Promise<unknown>>()
  private generation = 0
  private request: AbortController | null = null
  private eventSubscription: OpenCodeV2EventSubscription | null = null
  /** While live events arrive, polls refresh tool activity from durable messages only occasionally. */
  private liveHealthy = false
  private liveText: ReadonlyMap<string, LiveText> = new Map()
  private projectedMessages: RemoteMessage[] = []
  private projectedById: ReadonlyMap<string, RemoteMessage> = new Map()
  /** Visible text per assistant message, so a live delta re-renders only its own message. */
  private textParts: ReadonlyMap<string, readonly string[]> = new Map()
  private textOrder: readonly string[] = []
  private refreshedAt = { messages: 0, permissions: 0 }
  private refreshing: Promise<void> | null = null
  private readonly intervals: { messages: number; live: number; permissions: number }
  private beforeMessages = new Set<string>()
  private remoteSessionId = ''
  private nextAttachment = 0
  private terminalQueue: Promise<unknown> = Promise.resolve()
  constructor(private readonly storage: CompanionStorage, private readonly getProxyConfig: () => ProxyConnection, private readonly bundledExecutable?: string,
    private readonly resolveConnection?: (model: string) => Promise<ModelConnection>, options: OpenCodeServiceOptions = {}) {
    this.intervals = { messages: 1000, live: 3000, permissions: 750, ...options.refreshIntervals }
  }
  private executable() { return managedRuntimeExecutable(this.storage.home) || (this.bundledExecutable && existsSync(this.bundledExecutable) ? this.bundledExecutable : runtimeExecutable(this.storage.home)) }
  available() { return existsSync(this.executable()) }
  isBusy() { return this.agentStarting || this.terminalPreparing || this.stopping || this.current.running || this.attachmentServers.size > 0 }
  /** A chat turn is starting, running or stopping; Work tabs do not count. */
  agentBusy() { return this.agentStarting || this.stopping || this.current.running }

  private guard(owner: Owner, attempt: number) {
    return () => { if (attempt !== (owner === 'agent' ? this.agentAttempt : this.terminalAttempt)) throw new Error('Agent task cancelled') }
  }
  /** Plain chats use an app-owned empty directory, never the user's saved grants. */
  private async resolveAccess(input: ScopeInput, saved: { workspaces: WorkspaceGrant[]; groups?: WorkspaceGroup[] }) {
    if (input.workspaceId !== '') return workspaceAccess(saved.workspaces, saved.groups || [], input)
    if ((input.groupId !== undefined && input.groupId !== '')
      || (input.relativePath !== undefined && input.relativePath !== '')
      || (input.accessScope !== undefined && input.accessScope !== 'group')) {
      throw new Error('Select a workspace before specifying a group or folder scope')
    }
    const selected: WorkspaceGrant = { id: '__dailyworkmate_private_chat__', name: 'Chat',
      path: path.join(this.storage.home, 'data', 'opencode-v2', 'chat-workspace'), writable: false }
    await mkdir(selected.path, { recursive: true })
    return workspaceAccess([selected], [], { workspaceId: selected.id, accessScope: 'group' })
  }
  /** Start or reuse the server for this scope. The returned server is held; the caller releases the hold. */
  private async launch(owner: Owner, input: ScopeInput, grants: WorkspaceGrant[], selected: WorkspaceGrant, model: string, active: () => void, freeModel?: OpenCodeFreeModel): Promise<Server> {
    active()
    const { allowShell, autoApproveCommands } = shellPolicy(owner, input, grants)
    const connection: ModelConnection | undefined = freeModel ? undefined : this.resolveConnection
      ? await this.resolveConnection(model)
      : { ...proxyConnection(this.getProxyConfig()), model, protocol: 'openai', direct: false }
    active()
    const { baseURL = '', apiKey = '' } = connection || {}
    const headerValues = Object.entries(connection?.headers || {}).sort(([left], [right]) => left.localeCompare(right))
    const headerEnvironment = Object.fromEntries(headerValues.map(([, value], index) => ['DAILYWORKMATE_MODEL_HEADER_' + index, value]))
    const configConnection = connection ? { ...connection, headers: Object.fromEntries(headerValues.map(([name], index) => [name, '{env:DAILYWORKMATE_MODEL_HEADER_' + index + '}'])) } : undefined
    const data = path.join(this.storage.home, 'data', 'opencode-v2')
    const identity = JSON.stringify({ config: buildOpenCodeV2Config(grants, selected, model, baseURL, undefined, freeModel, path.join(data, 'servers'), allowShell, autoApproveCommands, configConnection), apiKey, headers: headerValues, autoApproveCommands, owner, directory: selected.path, scope: { workspaceId: input.workspaceId, groupId: input.groupId, accessScope: input.accessScope, relativePath: input.relativePath } })
    const key = createHash('sha256').update(identity).digest('hex').slice(0, 16)
    const pending = this.launches.get(key)
    if (pending) {
      // A concurrent launch for the same owner and scope is starting this exact server (owner is part of the
      // identity, so chat and Work never share one): wait for it instead of starting a second process.
      await pending.catch(() => undefined)
      return this.launch(owner, input, grants, selected, model, active, freeModel)
    }
    const existing = this.servers.get(key)
    if (existing?.validated && existing.child && existing.address && !existing.retired) { existing.holds++; return existing }
    if (existing) this.shutdownServer(existing)
    const started = this.startServer(owner, key, input, grants, selected, model, active,
      { allowShell, autoApproveCommands, apiKey, headerValues, headerEnvironment, configConnection, freeModel, baseURL })
    this.launches.set(key, started)
    try { return await started } finally { if (this.launches.get(key) === started) this.launches.delete(key) }
  }

  private async startServer(owner: Owner, key: string, input: ScopeInput, grants: WorkspaceGrant[], selected: WorkspaceGrant, model: string, active: () => void,
    options: ShellPolicy & { apiKey: string; baseURL: string; headerValues: Array<[string, string]>; headerEnvironment: Record<string, string>; configConnection?: ModelConnection; freeModel?: OpenCodeFreeModel }): Promise<Server> {
    const { allowShell, autoApproveCommands, apiKey, baseURL, headerValues, headerEnvironment, configConnection, freeModel } = options
    const data = path.join(this.storage.home, 'data', 'opencode-v2')
    // A server left by a crashed run may still hold this profile's database.
    await staleProcessesReaped(this.storage.home)
    const closing = closingIn(this.storage.home)
    if (closing.length && (await Promise.all(closing)).includes(false)) throw new Error('The previous OpenCode process did not stop. Please retry after it exits.')
    active()
    if (!this.available()) throw new Error('OpenCode is not installed. Run npm run companion:setup in the project folder.')
    const directory = path.join(data, 'servers', key)
    const guard = path.join(directory, 'guard')
    const config = buildOpenCodeV2Config(grants, selected, model, baseURL, undefined, freeModel, guard, allowShell, autoApproveCommands, configConnection)
    await Promise.all([...['config', 'cache', 'data', 'state', 'home', 'tmp'].map(name => path.join(data, name)), directory].map(folder => mkdir(folder, { recursive: true })))
    await installWorkspaceGuardV2(guard, grants, selected.path, allowShell)
    // The exported config contains an environment reference, never the actual proxy key.
    await writeFile(path.join(directory, 'opencode.json'), JSON.stringify(config, null, 2), { mode: 0o600 })
    const port = await new Promise<number>((resolve, reject) => {
      const probe = createServer()
      probe.once('error', reject)
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address()
        if (!address || typeof address === 'string') { probe.close(); reject(new Error('Unable to allocate OpenCode port')); return }
        probe.close(error => error ? reject(error) : resolve(address.port))
      })
    })
    active()
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      ['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'USERPROFILE', 'HOME'].includes(key.toUpperCase())))
    const server: Server = { key, owner, modelID: freeModel?.apiModel || configConnection?.model || model, access: accessKey(grants, selected, allowShell, autoApproveCommands), input: { workspaceId: input.workspaceId, groupId: input.groupId, accessScope: input.accessScope, relativePath: input.relativePath }, autoApproveCommands,
      child: null, address: '', password: randomBytes(32).toString('hex'), client: null, validated: false, attachments: new Set(), holds: 0, retired: false, exited: Promise.resolve(true) }
    const executable = this.executable(), spawnedAfter = Date.now()
    const child = spawn(executable, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
      cwd: selected.path, windowsHide: true, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...inherited,
        XDG_CONFIG_HOME: path.join(data, 'config'), XDG_CACHE_HOME: path.join(data, 'cache'),
        XDG_DATA_HOME: path.join(data, 'data'), XDG_STATE_HOME: path.join(data, 'state'),
        OPENCODE_TEST_HOME: path.join(data, 'home'),
        HOME: path.join(data, 'home'), USERPROFILE: path.join(data, 'home'),
        TEMP: path.join(data, 'tmp'), TMP: path.join(data, 'tmp'), TMPDIR: path.join(data, 'tmp'),
        OPENCODE_CONFIG: path.join(directory, 'opencode.json'), OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        OPENCODE_CONFIG_DIR: path.join(data, 'config', 'opencode'), OPENCODE_CONFIG_PROJECT_DISABLE: 'true',
        BUN_INSTALL_CACHE_DIR: path.join(data, 'cache', 'bun'),
        OPENCODE_DISABLE_AUTOUPDATE: 'true',
        OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_PASSWORD: server.password, OPENCODE_SERVER_PASSWORD: server.password,
        DAILYWORKMATE_PROXY_KEY: apiKey,
        ...headerEnvironment,
      },
    })
    trackProcess(this.storage.home, child, { kind: 'opencode', executable, marker: '--port ' + port, spawnedAfter, spawnedBefore: Date.now(), group: process.platform !== 'win32' })
    server.child = child
    this.servers.set(key, server)
    await new Promise<void>((resolve, reject) => {
      let output = ''
      let settled = false
      const timer = setTimeout(() => finish(new Error('OpenCode startup timed out')), 45000)
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) reject(error); else resolve()
      }
      const receive = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-16000)
        const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/)
        if (match && server.child === child) { server.address = match[0]; finish() }
      }
      child.stdout?.on('data', receive)
      child.stderr?.on('data', receive)
      child.once('error', error => finish(new Error('Unable to start OpenCode: ' + error.message)))
      child.once('exit', (code, signal) => {
        const details = [server.password, apiKey, ...headerValues.map(([, value]) => value)].filter(Boolean).reduce((text, secret) => text.split(secret).join('[redacted]'), output)
          .replace(/\u001b\[[0-9;]*m/g, '').trim().slice(-1800)
        finish(new Error('OpenCode exited during startup (' + (code ?? signal) + ')' + (details ? ': ' + details : '')))
        if (server.child === child) {
          server.child = null
          this.forget(server, 'OpenCode exited (' + (code ?? signal) + ')')
        }
      })
    }).catch(error => { this.shutdownServer(server); throw error })
    try {
      active()
      const client = new OpenCodeV2Client(server.address, server.password, selected.path)
      await client.health()
      await client.location()
      await client.assertGuard('dailyworkmate-workspace-guard-v2', path.join(guard, 'index.js'))
      active()
      // V2 paths are relative to the selected location, even within a larger Git
      // worktree. Its verified configuration is ready without a second startup.
      server.client = client
      server.validated = true
      const current = await this.storage.get()
      const access = await this.resolveAccess(input, current)
      const policy = shellPolicy(owner, input, access.grants)
      if (server.retired || accessKey(access.grants, access.selected, policy.allowShell, policy.autoApproveCommands) !== server.access) throw new Error('Folder permissions changed during startup. Reconnect to apply them.')
      server.holds++
      return server
    } catch (error) { this.shutdownServer(server); throw error }
  }

  /** A failed managed update falls back to the previous runtime, unless anything else still uses it. */
  private async rollback(error: unknown, active: () => void) {
    active()
    const inUse = this.attachmentServers.size > 0 || this.current.running || this.launches.size > 0 || [...this.servers.values()].some(server => server.holds > 0)
    if (!(error instanceof Error) || !/Unable to start OpenCode:.*(?:ENOENT|ENOEXEC|not a valid Win32)|OpenCode exited during startup/i.test(error.message) || !managedRuntimeExecutable(this.storage.home) || inUse) throw error
    console.error('[Companion] Updated OpenCode failed to start; restoring previous runtime:', error instanceof Error ? error.message : String(error))
    for (const server of [...this.servers.values()]) this.shutdownServer(server)
    await Promise.all(closingIn(this.storage.home))
    await rollbackManagedRuntime(this.storage.home)
  }
  private async launchWithRollback(owner: Owner, input: ScopeInput, grants: WorkspaceGrant[], selected: WorkspaceGrant, model: string, active: () => void, freeModel?: OpenCodeFreeModel) {
    try { return await this.launch(owner, input, grants, selected, model, active, freeModel) }
    catch (error) {
      await this.rollback(error, active)
      return this.launch(owner, input, grants, selected, model, active, freeModel)
    }
  }

  async start(input: AgentInput): Promise<AgentSnapshot> {
    // Native Work tabs own separate sessions and startup state and must not block chat turns.
    // isBusy() still includes them so runtime updates cannot stop an attached tab.
    if (this.agentStarting || this.stopping || this.current.running) throw new Error('An agent task is already running or stopping')
    if (!input || typeof input !== 'object') throw new Error('Invalid agent request')
    boundedText(input.prompt, 'task', 2_000_000, true)
    boundedText(input.model, 'model', 300, true)
    const systemPrompt = input.systemPrompt === undefined ? '' : boundedText(input.systemPrompt, 'system prompt', 100000)
    this.agentStarting = true
    const active = this.guard('agent', ++this.agentAttempt)
    try {
      const saved = await this.storage.get()
      const { selected, grants, group, sessionScope, legacySessionScope, previousSessionScope } = await this.resolveAccess(input, saved)
      const freeModel = isOpenCodeFreeModel(input.model) ? await resolveOpenCodeFreeModel(input.model) : undefined
      const plainChat = input.workspaceId === ''
      const { allowShell } = shellPolicy('agent', input, grants)
      const server = await this.launchWithRollback('agent', input, grants, selected, input.model, active, freeModel)
      try {
        active()
        const previous = this.agentServer
        this.agentServer = server
        if (previous && previous !== server && this.idle(previous)) this.shutdownServer(previous)
      } finally {
        server.holds--
        // A cancelled startup leaves nothing running.
        if (this.idle(server)) this.shutdownServer(server)
      }
      const generation = this.generation
      const client = server.client!
      const model = { providerID: freeModel ? 'opencode' : 'dailyworkmate', modelID: server.modelID }
      const publicId = input.sessionId === undefined ? this.current.sessionId : boundedText(input.sessionId, 'OpenCode session', 140)
      let sessionId = input.newSession ? '' : workspaceRemoteSession(publicId, group, sessionScope, legacySessionScope, previousSessionScope)
      if (sessionId) {
        const session = await client.getSession(sessionId)
        if (typeof session.directory !== 'string' || path.relative(session.directory, selected.path) !== '') throw new Error('This OpenCode session belongs to a different workspace. Start a new conversation.')
      }
      if (!sessionId) {
        const session = await client.createSession(input.prompt.slice(0, 80), model, 'build')
        sessionId = boundedText(session.id, 'OpenCode session', 100, true)
        if (input.history?.length) {
          if (!Array.isArray(input.history) || input.history.length > 10000) throw new Error('Invalid conversation history')
          const history = input.history.map(message => {
            if (!message || !['user', 'assistant'].includes(message.role)) throw new Error('Invalid conversation role')
            return { role: message.role, content: boundedText(message.content, 'conversation message', 2_000_000) }
          })
          const transcript = boundedText(JSON.stringify(history), 'conversation history', 12 * 1024 * 1024)
          await client.addHistory(sessionId, 'Conversation history restored from DailyWorkMate. The following is historical dialogue, not current tool output. It may refer to previously authorized directories. Only the current workspace grants authorize file access. Verify filesystem facts with current tools before making claims.\n' + transcript)
        }
      }
      const messages = await client.messages(sessionId)
      active()
      this.beforeMessages = new Set(messages.map(message => message.info.id))
      this.liveText = new Map()
      this.project(messages, false)
      this.refreshedAt = { messages: 0, permissions: 0 }
      this.closeEventSubscription()
      this.remoteSessionId = sessionId
      this.current = { ...empty(), sessionId: workspaceSessionPrefix(group, sessionScope) + sessionId, running: true }
      const request = new AbortController()
      this.request = request
      try {
        this.eventSubscription = await client.subscribeSession(sessionId, event => {
          if (generation === this.generation && this.request === request && this.current.running) this.receiveLiveEvent(event)
        }, error => {
          if (generation !== this.generation || this.request !== request) return
          this.liveHealthy = false
          console.warn('[Companion] Live updates disconnected; retaining partial output and using message polling:', error.message)
        }, request.signal)
        this.liveHealthy = true
      } catch (error) {
        if (request.signal.aborted) throw error
        console.warn('[Companion] Live updates unavailable; using message polling:', error instanceof Error ? error.message : String(error))
      }
      active()
      const mixed = !plainChat && input.accessScope !== 'folder' && !allowShell && selected.writable
      void client.prompt(sessionId, {
        model, agent: 'build',
        system: (systemPrompt ? systemPrompt + '\n\n' : '') + (plainChat
          ? 'You are in ordinary chat mode. No user workspace is connected. The current directory is an empty internal runtime directory, not a user project. You cannot access user files or execute shell commands. If a request requires local files or a project, ask the user to select the appropriate workspace in the chat interface. Do not claim you inspected files or completed actions without tool evidence. Reply naturally in the user\'s language.'
          : 'You are now in workspace mode. Current directory: ' + selected.path
          + (group ? '\nCurrent workspace group: ' + group.name : '')
          + '\nAuthorized folders for this conversation (path and permission):\n'
          + JSON.stringify(grants.map(grant => ({ path: grant.path, permission: grant.writable ? 'read and write' : 'READ ONLY' })))
          + '\nYou may read, search and list files in every folder listed above, including other folders in the same group, using absolute paths. File edits are allowed only inside folders marked read and write.'
          + (input.accessScope === 'folder' ? '\nThis is a restricted folder scope. Shell commands are disabled; use the authorized file tools.'
            : allowShell ? '\nThe user has authorized shell commands in this writable workspace. Execute them directly without requesting further approval, and respect each folder permission.'
              : mixed ? '\nShell commands are disabled because some authorized folders are READ ONLY. Use the file tools; edit only inside folders marked read and write.'
                : '\nThe current directory is READ ONLY, so shell commands are disabled. Use read, glob, grep or list for inspection; use edit tools only in any other folder explicitly marked read and write.')
          + '\nFor questions about actual files, inspect them with tools before answering. Only claim actions confirmed by tool output. Work only in authorized directories. Reply in the user\'s language. Do not expose secrets.'),
        text: input.prompt,
      }, request.signal).then(() => {
        if (generation !== this.generation || this.request !== request) return
        // A tool-using turn spans several assistant messages. Fetch the whole turn
        // before marking it complete so the UI retains confirmed tool activity.
        return client.messages(sessionId).then(messages => {
          if (generation !== this.generation || this.request !== request) return
          this.request = null
          this.closeEventSubscription()
          this.liveText = new Map()
          this.current = { ...this.current, running: false, ...this.project(messages, false), phase: undefined, permissions: [] }
        })
      }).catch(error => {
        if (generation !== this.generation || this.request !== request) return
        const detail = axios.isAxiosError(error) ? error.response?.data?.message || error.response?.data?.error?.message : ''
        const message = axios.isAxiosError(error) ? 'OpenCode v2 request failed' + (error.response ? ' (HTTP ' + error.response.status + ')' : ': ' + error.code) + (typeof detail === 'string' ? ': ' + detail.slice(0, 2000) : '') : error instanceof Error ? error.message : String(error)
        this.request = null
        this.closeEventSubscription()
        this.current = { ...this.current, running: false, error: message, phase: undefined, permissions: [] }
      })
      return structuredClone(this.current)
    } finally { this.agentStarting = false }
  }

  /**
   * Prepare a guarded native session without submitting a model request. Credentials stay in main.
   * Each Work tab attaches to the server for its own folder scope; preparations are serialized.
   */
  private cancelledTerminals = new Set<string>()
  /** Preparations queued or running; only these can be cancelled, so cancellations never accumulate. */
  private queuedTerminals = new Set<string>()
  private preparingTerminal = ''
  cancelPreparation(id: string) {
    if (!this.queuedTerminals.has(id)) return
    this.cancelledTerminals = new Set([...this.cancelledTerminals, id])
    if (this.preparingTerminal === id) {
      this.terminalAttempt++
      for (const server of this.servers.values()) if (server.owner === 'terminal' && !server.validated && this.idle(server)) this.shutdownServer(server)
    }
  }
  prepareTerminal(input: TerminalInput) {
    const id = input?.terminalId || ''
    this.queuedTerminals = new Set([...this.queuedTerminals, id])
    const run = async () => {
      if (this.cancelledTerminals.has(id)) throw new Error('Terminal startup cancelled')
      this.preparingTerminal = id
      try { return await this.prepareTerminalNow(input) } finally { this.preparingTerminal = '' }
    }
    const result = this.terminalQueue.then(run, run).finally(() => {
      this.queuedTerminals = new Set([...this.queuedTerminals].filter(item => item !== id))
      this.cancelledTerminals = new Set([...this.cancelledTerminals].filter(item => item !== id))
    })
    this.terminalQueue = result.catch(() => undefined)
    return result
  }

  /** A display client can rejoin only while its original guarded process remains alive. */
  terminalAttachmentAlive(attachment: number): boolean {
    const server = this.attachmentServers.get(attachment)
    return !!server && !server.retired && server.validated && !!server.client && !!server.address
      && !!server.child && !server.child.killed && server.child.exitCode == null && server.child.signalCode == null
  }

  /** Release one Work tab; its server stops when nothing else uses it. */
  async releaseTerminal(attachment: number) {
    const server = this.attachmentServers.get(attachment)
    if (!server || !server.attachments.delete(attachment)) return
    this.attachmentServers.delete(attachment)
    if (this.idle(server)) { this.shutdownServer(server); if (!await server.exited) throw new Error('The previous OpenCode process did not stop') }
  }

  /**
   * After folder permissions change, retire every server whose grants are outdated and
   * report its native clients so their tabs reconnect under the current permissions.
   */
  async staleAttachments(): Promise<Set<number>> {
    const saved = await this.storage.get()
    const stale = new Set<number>()
    for (const server of [...this.servers.values()]) {
      let access = ''
      try {
        const current = await this.resolveAccess(server.input, saved)
        const policy = shellPolicy(server.owner, server.input, current.grants)
        access = accessKey(current.grants, current.selected, policy.allowShell, policy.autoApproveCommands)
      } catch { /* The folder was removed or left its group; the grants no longer exist. */ }
      if (access === server.access) continue
      server.retired = true
      for (const attachment of server.attachments) stale.add(attachment)
      if (server === this.agentServer || this.idle(server)) this.shutdownServer(server)
    }
    return stale
  }

  private idle(server: Server) { return !server.attachments.size && !server.holds && server !== this.agentServer }

  private async prepareTerminalNow(input: TerminalInput) {
    if (this.terminalPreparing) throw new Error('Another Work tab is still starting')
    if (!input || typeof input !== 'object') throw new Error('Invalid terminal request')
    boundedText(input.model, 'model', 300, true)
    this.terminalPreparing = true
    const active = this.guard('terminal', ++this.terminalAttempt)
    try {
      const saved = await this.storage.get()
      const { selected, grants, group, sessionScope, legacySessionScope, previousSessionScope } = await workspaceAccess(saved.workspaces, saved.groups || [], input)
      const freeModel = isOpenCodeFreeModel(input.model) ? await resolveOpenCodeFreeModel(input.model) : undefined
      const { allowShell } = shellPolicy('terminal', input, grants)
      // The launch hold keeps a tab closing meanwhile from stopping the server this tab is about to join.
      const server = await this.launchWithRollback('terminal', input, grants, selected, input.model, active, freeModel)
      try {
        active()
        const client = server.client!
        const model = { providerID: freeModel ? 'opencode' : 'dailyworkmate', modelID: server.modelID }
        const publicId = boundedText(input.sessionId || '', 'OpenCode session', 140)
        let sessionId = input.newSession ? '' : workspaceRemoteSession(publicId, group, sessionScope, legacySessionScope, previousSessionScope)
        if (sessionId) {
          const session = await client.getSession(sessionId)
          if (path.relative(session.directory, selected.path) !== '') throw new Error('This session belongs to a different workspace')
        } else {
          sessionId = (await client.createSession(group?.name || selected.name, model, 'build')).id
          if (input.history?.length) {
            if (!Array.isArray(input.history) || input.history.length > 10000) throw new Error('Invalid conversation history')
            const history = input.history.map(message => {
              if (!message || !['user', 'assistant'].includes(message.role)) throw new Error('Invalid conversation role')
              return { role: message.role, content: boundedText(message.content, 'conversation message', 2_000_000) }
            })
            await client.addHistory(sessionId, 'Historical DailyWorkMate dialogue. Verify file facts using current tools. Only current workspace grants authorize access.\n' + boundedText(JSON.stringify(history), 'conversation history', 12 * 1024 * 1024))
          }
        }
        await client.selectModel(sessionId, model)
        await client.setInstructions(sessionId, 'Current directory: ' + selected.path
          + '\nAuthorized folders: ' + JSON.stringify(grants.map(grant => ({ path: grant.path, permission: grant.writable ? 'read and write' : 'READ ONLY' })))
          + '\nUse tools to verify file facts. Respect each folder permission. Shell commands require approval.'
          + (!allowShell ? '\nShell commands are disabled in this restricted folder scope.' : '')
          + '\nReply in the user\'s language. Do not expose secrets.')
        active()
        const currentSaved = await this.storage.get()
        const currentAccess = await workspaceAccess(currentSaved.workspaces, currentSaved.groups || [], input)
        if (accessKey(currentAccess.grants, currentAccess.selected, allowShell) !== server.access) throw new Error('Folder permissions changed. Reconnect to apply them.')
        if (server.retired || !server.client) throw new Error('文件夹权限已更改，请重新连接。 / Folder permissions changed. Reconnect to apply them.')
        const attachment = ++this.nextAttachment
        server.attachments.add(attachment)
        this.attachmentServers.set(attachment, server)
        return { executable: this.executable(), address: server.address, password: server.password, attachment,
          directory: selected.path, remoteSessionId: sessionId, sessionId: workspaceSessionPrefix(group, sessionScope) + sessionId }
      } finally {
        server.holds--
        if (this.idle(server)) this.shutdownServer(server)
      }
    } finally { this.terminalPreparing = false }
  }

  private closeEventSubscription() {
    this.eventSubscription?.close()
    this.eventSubscription = null
    this.liveHealthy = false
  }
  private receiveLiveEvent(event: OpenCodeV2LiveEvent) {
    if (event.type === 'phase') { this.current = { ...this.current, phase: event.phase }; return }
    if (this.beforeMessages.has(event.messageId)) return
    const key = event.messageId + ':' + event.ordinal
    const previous = this.liveText.get(key)
    if (previous?.complete && event.operation !== 'end') return
    const text = event.operation === 'end' ? event.text
      : event.operation === 'delta' ? (previous?.text || '') + event.text : previous?.text || ''
    if (text.length > 32 * 1024 * 1024) {
      this.closeEventSubscription()
      console.warn('[Companion] Live text exceeded the size limit; using message polling')
      return
    }
    // Only the changed message is re-rendered; tools and errors come from durable messages.
    this.liveText = new Map(this.liveText).set(key, { messageId: event.messageId, ordinal: event.ordinal, text, complete: event.operation === 'end' })
    const parts = this.visibleText(this.projectedById.get(event.messageId), event.messageId, [...this.liveText.values()])
    this.textParts = new Map(this.textParts).set(event.messageId, parts)
    if (!this.textOrder.includes(event.messageId)) this.textOrder = [...this.textOrder, event.messageId]
    this.current = { ...this.current, text: joinText(this.textOrder, this.textParts), phase: 'responding' }
  }
  /** Text parts of one assistant message, with live blocks overlaying ones not yet persisted. */
  private visibleText(message: RemoteMessage | undefined, id: string, live: readonly LiveText[]): string[] {
    const projected = message?.parts || []
    const blocks = live.filter(block => block.messageId === id)
    const parts = !blocks.length ? projected : [...new Map<number, RemotePart>([
      ...projected.map((part, index): [number, RemotePart] => [index, part]),
      ...blocks.map((block): [number, RemotePart] => {
        const persisted = projected[block.ordinal]
        const text = !block.complete && persisted?.type === 'text' && (persisted.text?.length || 0) > block.text.length ? persisted.text! : block.text
        return [block.ordinal, { id: id + ':' + block.ordinal, type: 'text', text }]
      }),
    ]).entries()].sort(([a], [b]) => a - b).map(([, part]) => part)
    return parts.filter(part => part.type === 'text').map(part => part.text || '')
  }
  /** Rebuild the projection from durable messages; live blocks still overlay unpersisted text. */
  private project(messages: RemoteMessage[], includeLive: boolean) {
    const assistants = messages.filter(message => message.info.role === 'assistant' && !this.beforeMessages.has(message.info.id))
    const live = includeLive ? [...this.liveText.values()] : []
    const order = [...new Set([...assistants.map(message => message.info.id), ...live.map(block => block.messageId)])]
    const byId = new Map(assistants.map(message => [message.info.id, message]))
    const parts = new Map(order.map(id => [id, this.visibleText(byId.get(id), id, live)]))
    this.projectedMessages = messages
    this.projectedById = byId
    this.textParts = parts
    this.textOrder = order
    return {
      text: joinText(order, parts),
      tools: assistants.flatMap(message => message.parts.filter(part => part.type === 'tool').map(part => ({
        id: part.id, name: part.tool || 'tool', status: part.state?.status || '',
        title: (part.state?.title || JSON.stringify(part.state?.input || {})).slice(0, 500),
      }))).slice(-80),
      error: assistants.map(message => message.info.error?.data?.message || message.info.error?.name || '').filter(Boolean).join('\n'),
    }
  }
  /**
   * Snapshots are immutable, so the current one is returned without copying. Remote state is
   * refreshed at most every few hundred milliseconds; live events already carry the text.
   */
  async poll(): Promise<AgentSnapshot> {
    if (!this.agentServer?.client || !this.remoteSessionId || !this.current.running) return this.current
    const now = Date.now()
    const messagesDue = now - this.refreshedAt.messages >= (this.liveHealthy ? this.intervals.live : this.intervals.messages)
    if (messagesDue || now - this.refreshedAt.permissions >= this.intervals.permissions) await this.refresh(messagesDue)
    return this.current
  }
  private refresh(withMessages: boolean): Promise<void> {
    if (this.refreshing) return this.refreshing
    const pending = this.refreshNow(withMessages).finally(() => { if (this.refreshing === pending) this.refreshing = null })
    this.refreshing = pending
    return pending
  }
  private async refreshNow(withMessages: boolean) {
    const client = this.agentServer?.client
    if (!client || !this.remoteSessionId || !this.current.running) return
    const generation = this.generation
    const request = this.request
    const sessionId = this.current.sessionId
    const [messages, permissions] = await Promise.all([
      withMessages ? client.messages(this.remoteSessionId) : Promise.resolve(null),
      client.permissions(this.remoteSessionId),
    ])
    if (generation !== this.generation || request !== this.request || sessionId !== this.current.sessionId) return
    const now = Date.now()
    this.refreshedAt = { messages: messages ? now : this.refreshedAt.messages, permissions: now }
    const summary = messages ? this.project(messages, true) : null
    this.current = { ...this.current, ...(summary ? { ...summary, error: summary.error || this.current.error } : {}),
      permissions: permissions.map(item => ({ id: item.id, sessionID: this.current.sessionId, permission: item.permission, patterns: item.patterns })),
    }
  }
  async reply(id: string, allow: boolean) {
    boundedText(id, 'permission ID', 100, true)
    if (typeof allow !== 'boolean') throw new Error('Invalid permission response')
    const server = this.agentServer
    const sessionId = this.remoteSessionId
    await this.refresh(false)
    // The server may have exited or the turn ended while the permissions were refreshed.
    const client = this.agentServer?.client
    if (!client || this.agentServer !== server || this.remoteSessionId !== sessionId || !this.current.running) {
      throw new Error('该工作区会话已结束。 / This workspace session has ended.')
    }
    if (!this.current.permissions.some(permission => permission.id === id)) throw new Error('Permission request expired')
    await client.reply(sessionId, id, allow)
  }
  async stop() {
    if (this.stopping) return
    const server = this.agentServer
    if (server?.client && this.remoteSessionId && this.current.running) {
      this.agentAttempt++
      const client = server.client
      const sessionId = this.remoteSessionId
      const generation = this.generation
      const request = this.request
      this.stopping = true
      this.request = null
      this.closeEventSubscription()
      request?.abort()
      try { await client.abort(sessionId) }
      catch (error) { if (generation === this.generation) this.shutdownServer(server); throw error }
      finally {
        this.stopping = false
        if (generation === this.generation) this.current = { ...this.current, running: false, phase: undefined, permissions: [] }
      }
    } else if (this.agentStarting) {
      // Cancel a chat startup: its server may still be waiting for OpenCode to listen.
      this.agentAttempt++
      for (const server of [...this.servers.values()]) if (server.owner === 'agent' && !server.validated && this.idle(server)) this.shutdownServer(server)
    }
  }
  /** Stop every server and resolve once their processes have exited. */
  dispose() {
    this.agentAttempt++
    this.terminalAttempt++
    const retries = [...this.failedChildren].map(child => stopChildProcess(child, true).then(() => { this.failedChildren.delete(child); return true }))
    const servers = [...this.servers.values()]
    for (const server of servers) this.shutdownServer(server)
    this.resetAgent()
    return Promise.all([...retries, ...servers.map(server => server.exited), ...closingIn(this.storage.home)]).then(results => {
      if (results.includes(false)) throw new Error('An OpenCode process did not stop; retry quitting after it exits')
    })
  }
  private resetAgent() {
    this.generation++
    this.closeEventSubscription()
    this.liveText = new Map()
    this.project([], false)
    this.request?.abort()
    this.request = null
    this.agentServer = null
    this.remoteSessionId = ''
    this.current = empty()
  }
  /** Drop a server from the pool; native clients cannot outlive it, so late releases become no-ops. */
  private forget(server: Server, reason: string) {
    if (this.servers.get(server.key) === server) this.servers.delete(server.key)
    for (const attachment of server.attachments) this.attachmentServers.delete(attachment)
    server.attachments.clear()
    server.address = ''
    server.client = null
    server.validated = false
    if (this.agentServer === server) {
      this.agentServer = null
      this.current = { ...this.current, running: false, error: reason }
    }
  }
  private shutdownServer(server: Server) {
    const agent = this.agentServer === server
    this.forget(server, '')
    if (agent) this.resetAgent()
    const child = server.child
    server.child = null
    if (!child || child.killed) return
    const closed = stopChildProcess(child, true).then(() => true, error => {
      console.error('[Companion] Process cleanup failed:', error)
      this.failedChildren.add(child)
      return false
    })
    server.exited = closed
    const home = this.storage.home
    const pending = closingProcesses.get(home) || new Set<Promise<boolean>>()
    closingProcesses.set(home, pending.add(closed))
    void closed.then(() => { pending.delete(closed); if (!pending.size && closingProcesses.get(home) === pending) closingProcesses.delete(home) })
  }
}
