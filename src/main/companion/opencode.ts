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

interface RemotePart { id: string; type: string; text?: string; tool?: string; state?: { status?: string; title?: string; input?: unknown; error?: string } }
interface RemoteMessage { info: { id: string; role: string; error?: { name?: string; data?: { message?: string } } }; parts: RemotePart[] }
interface LiveText { messageId: string; ordinal: number; text: string; complete: boolean }
type ScopeInput = Pick<AgentInput, 'workspaceId' | 'groupId' | 'accessScope' | 'relativePath'>
/** One guarded `opencode serve` process. Every folder scope and model gets its own. */
interface Server {
  key: string
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
  /** Native clients attached to this server, plus preparations about to attach. */
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
  private starting = false
  /** Only a legacy agent task, never a Work tab, can be stopped from the chat view. */
  private agentStarting = false
  private stopping = false
  private attempt = 0
  private generation = 0
  private request: AbortController | null = null
  private eventSubscription: OpenCodeV2EventSubscription | null = null
  private liveText: ReadonlyMap<string, LiveText> = new Map()
  private projectedMessages: RemoteMessage[] = []
  private beforeMessages = new Set<string>()
  private remoteSessionId = ''
  private nextAttachment = 0
  private terminalQueue: Promise<unknown> = Promise.resolve()
  constructor(private readonly storage: CompanionStorage, private readonly getProxyConfig: () => ProxyConnection, private readonly bundledExecutable?: string,
    private readonly resolveConnection?: (model: string) => Promise<ModelConnection>) {}
  private executable() { return managedRuntimeExecutable(this.storage.home) || (this.bundledExecutable && existsSync(this.bundledExecutable) ? this.bundledExecutable : runtimeExecutable(this.storage.home)) }
  available() { return existsSync(this.executable()) }
  isBusy() { return this.starting || this.stopping || this.current.running || this.attachmentServers.size > 0 }

  private assertActive(attempt: number) {
    if (attempt !== this.attempt) throw new Error('Agent task cancelled')
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
  private async launch(input: ScopeInput, grants: WorkspaceGrant[], selected: WorkspaceGrant, model: string, attempt: number, freeModel?: OpenCodeFreeModel, allowShell = true, autoApproveCommands = false): Promise<Server> {
    this.assertActive(attempt)
    const connection: ModelConnection | undefined = freeModel ? undefined : this.resolveConnection
      ? await this.resolveConnection(model)
      : { ...proxyConnection(this.getProxyConfig()), model, protocol: 'openai', direct: false }
    this.assertActive(attempt)
    const { baseURL = '', apiKey = '' } = connection || {}
    const headerValues = Object.entries(connection?.headers || {}).sort(([left], [right]) => left.localeCompare(right))
    const headerEnvironment = Object.fromEntries(headerValues.map(([, value], index) => ['DAILYWORKMATE_MODEL_HEADER_' + index, value]))
    const configConnection = connection ? { ...connection, headers: Object.fromEntries(headerValues.map(([name], index) => [name, '{env:DAILYWORKMATE_MODEL_HEADER_' + index + '}'])) } : undefined
    const data = path.join(this.storage.home, 'data', 'opencode-v2')
    const identity = JSON.stringify({ config: buildOpenCodeV2Config(grants, selected, model, baseURL, undefined, freeModel, path.join(data, 'servers'), allowShell, autoApproveCommands, configConnection), apiKey, headers: headerValues, autoApproveCommands, directory: selected.path, scope: { workspaceId: input.workspaceId, groupId: input.groupId, accessScope: input.accessScope, relativePath: input.relativePath } })
    const key = createHash('sha256').update(identity).digest('hex').slice(0, 16)
    const existing = this.servers.get(key)
    if (existing?.validated && existing.child && existing.address && !existing.retired) return existing
    if (existing) this.shutdownServer(existing)
    const closing = closingIn(this.storage.home)
    if (closing.length && (await Promise.all(closing)).includes(false)) throw new Error('The previous OpenCode process did not stop. Please retry after it exits.')
    this.assertActive(attempt)
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
    this.assertActive(attempt)
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      ['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'USERPROFILE', 'HOME'].includes(key.toUpperCase())))
    const server: Server = { key, modelID: freeModel?.apiModel || connection?.model || model, access: accessKey(grants, selected, allowShell, autoApproveCommands), input: { workspaceId: input.workspaceId, groupId: input.groupId, accessScope: input.accessScope, relativePath: input.relativePath }, autoApproveCommands,
      child: null, address: '', password: randomBytes(32).toString('hex'), client: null, validated: false, attachments: new Set(), holds: 0, retired: false, exited: Promise.resolve(true) }
    const child = spawn(this.executable(), ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
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
      this.assertActive(attempt)
      const client = new OpenCodeV2Client(server.address, server.password, selected.path)
      await client.health()
      await client.location()
      await client.assertGuard('dailyworkmate-workspace-guard-v2', path.join(guard, 'index.js'))
      this.assertActive(attempt)
      // V2 paths are relative to the selected location, even within a larger Git
      // worktree. Its verified configuration is ready without a second startup.
      server.client = client
      server.validated = true
      const current = await this.storage.get()
      const access = await this.resolveAccess(input, current)
      if (server.retired || accessKey(access.grants, access.selected, allowShell, autoApproveCommands) !== server.access) throw new Error('Folder permissions changed during startup. Reconnect to apply them.')
      return server
    } catch (error) { this.shutdownServer(server); throw error }
  }

  /** A failed managed update falls back to the previous runtime, unless open tabs still use it. */
  private async rollback(error: unknown, attempt: number) {
    this.assertActive(attempt)
    if (!(error instanceof Error) || !/Unable to start OpenCode:.*(?:ENOENT|ENOEXEC|not a valid Win32)|OpenCode exited during startup/i.test(error.message) || !managedRuntimeExecutable(this.storage.home) || this.attachmentServers.size > 0) throw error
    console.error('[Companion] Updated OpenCode failed to start; restoring previous runtime:', error instanceof Error ? error.message : String(error))
    for (const server of [...this.servers.values()]) this.shutdownServer(server)
    await Promise.all(closingIn(this.storage.home))
    await rollbackManagedRuntime(this.storage.home)
  }

  async start(input: AgentInput): Promise<AgentSnapshot> {
    // Native Work tabs own separate sessions and must not block chat turns.
    // isBusy() still includes them so runtime updates cannot stop an attached tab.
    if (this.starting || this.stopping || this.current.running) throw new Error('An agent task is already running or stopping')
    if (!input || typeof input !== 'object') throw new Error('Invalid agent request')
    boundedText(input.prompt, 'task', 2_000_000, true)
    boundedText(input.model, 'model', 300, true)
    const systemPrompt = input.systemPrompt === undefined ? '' : boundedText(input.systemPrompt, 'system prompt', 100000)
    this.starting = true
    this.agentStarting = true
    const attempt = ++this.attempt
    try {
      const saved = await this.storage.get()
      const { selected, grants, group, sessionScope, legacySessionScope, previousSessionScope } = await this.resolveAccess(input, saved)
      const freeModel = isOpenCodeFreeModel(input.model) ? await resolveOpenCodeFreeModel(input.model) : undefined
      const plainChat = input.workspaceId === ''
      const allowShell = !plainChat && input.accessScope !== 'folder'
      let server: Server
      try { server = await this.launch(input, grants, selected, input.model, attempt, freeModel, allowShell, true) }
      catch (error) {
        await this.rollback(error, attempt)
        server = await this.launch(input, grants, selected, input.model, attempt, freeModel, allowShell, true)
      }
      this.assertActive(attempt)
      const previous = this.agentServer
      if (previous && previous !== server && !previous.attachments.size) this.shutdownServer(previous)
      this.agentServer = server
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
      this.assertActive(attempt)
      this.beforeMessages = new Set(messages.map(message => message.info.id))
      this.projectedMessages = messages
      this.liveText = new Map()
      this.closeEventSubscription()
      this.remoteSessionId = sessionId
      this.current = { ...empty(), sessionId: workspaceSessionPrefix(group, sessionScope) + sessionId, running: true }
      const request = new AbortController()
      this.request = request
      try {
        this.eventSubscription = await client.subscribeSession(sessionId, event => {
          if (generation === this.generation && this.request === request && this.current.running) this.receiveLiveEvent(event)
        }, error => {
          if (generation === this.generation && this.request === request) console.warn('[Companion] Live updates disconnected; retaining partial output and using message polling:', error.message)
        }, request.signal)
      } catch (error) {
        if (request.signal.aborted) throw error
        console.warn('[Companion] Live updates unavailable; using message polling:', error instanceof Error ? error.message : String(error))
      }
      this.assertActive(attempt)
      void client.prompt(sessionId, {
        model, agent: 'build',
        system: (systemPrompt ? systemPrompt + '\n\n' : '') + (plainChat
          ? 'You are in ordinary chat mode. No user workspace is connected. The current directory is an empty internal runtime directory, not a user project. You cannot access user files or execute shell commands. If a request requires local files or a project, ask the user to select the appropriate workspace in the chat interface. Do not claim you inspected files or completed actions without tool evidence. Reply naturally in the user\'s language.'
          : 'You are now in workspace mode. Current directory: ' + selected.path
          + (group ? '\nCurrent workspace group: ' + group.name : '')
          + '\nAuthorized folders for this conversation (path and permission):\n'
          + JSON.stringify(grants.map(grant => ({ path: grant.path, permission: grant.writable ? 'read and write' : 'READ ONLY' })))
          + '\nYou may read, search and list files in every folder listed above, including other folders in the same group, using absolute paths. File edits are allowed only inside folders marked read and write.'
          + (!allowShell ? '\nThis is a restricted folder scope. Shell commands are disabled; use the authorized file tools.' : selected.writable ? '\nThe user has authorized shell commands in this writable workspace. Execute them directly without requesting further approval, and respect each folder permission.' : '\nThe current directory is READ ONLY, so shell commands are disabled. Use read, glob, grep or list for inspection; use edit tools only in any other folder explicitly marked read and write.')
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
          this.projectedMessages = messages
          this.current = { ...this.current, running: false, ...this.summarize(messages), phase: undefined, permissions: [] }
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
    } finally { this.starting = false; this.agentStarting = false }
  }

  /**
   * Prepare a guarded native session without submitting a model request. Credentials stay in main.
   * Each Work tab attaches to the server for its own folder scope; preparations are serialized.
   */
  private cancelledTerminals = new Set<string>()
  private preparingTerminal = ''
  cancelPreparation(id: string) {
    this.cancelledTerminals = new Set([...this.cancelledTerminals, id])
    if (this.preparingTerminal === id) {
      this.attempt++
      for (const server of this.servers.values()) if (!server.validated && this.idle(server)) this.shutdownServer(server)
    }
  }
  prepareTerminal(input: TerminalInput) {
    const run = async () => {
      const id = input.terminalId || ''
      if (this.cancelledTerminals.has(id)) { this.cancelledTerminals.delete(id); throw new Error('Terminal startup cancelled') }
      this.preparingTerminal = id
      try { return await this.prepareTerminalNow(input) } finally { this.preparingTerminal = ''; this.cancelledTerminals.delete(id) }
    }
    const result = this.terminalQueue.then(run, run)
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
        access = accessKey(current.grants, current.selected, server.input.workspaceId !== '' && server.input.accessScope !== 'folder', server.autoApproveCommands)
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
    if (this.starting || this.stopping || this.current.running) throw new Error('An OpenCode task is already running')
    if (!input || typeof input !== 'object') throw new Error('Invalid terminal request')
    boundedText(input.model, 'model', 300, true)
    this.starting = true
    const attempt = ++this.attempt
    try {
      const saved = await this.storage.get()
      const { selected, grants, group, sessionScope, legacySessionScope, previousSessionScope } = await workspaceAccess(saved.workspaces, saved.groups || [], input)
      const freeModel = isOpenCodeFreeModel(input.model) ? await resolveOpenCodeFreeModel(input.model) : undefined
      const allowShell = input.accessScope !== 'folder'
      let server: Server
      try { server = await this.launch(input, grants, selected, input.model, attempt, freeModel, allowShell) }
      catch (error) {
        await this.rollback(error, attempt)
        server = await this.launch(input, grants, selected, input.model, attempt, freeModel, allowShell)
      }
      // A tab closing meanwhile must not stop the server this tab is about to join.
      server.holds++
      try {
        this.assertActive(attempt)
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
        this.assertActive(attempt)
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
    } finally { this.starting = false }
  }

  private closeEventSubscription() {
    this.eventSubscription?.close()
    this.eventSubscription = null
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
    this.liveText = new Map([...this.liveText, [key, { messageId: event.messageId, ordinal: event.ordinal, text, complete: event.operation === 'end' }]])
    this.current = { ...this.current, ...this.summarize(this.projectedMessages, true), phase: 'responding' }
  }
  private summarize(messages: RemoteMessage[], includeLive = false) {
    let assistants = messages.filter(message => message.info.role === 'assistant' && !this.beforeMessages.has(message.info.id))
    if (includeLive && this.liveText.size) {
      const blocks = [...this.liveText.values()]
      const missing = [...new Set(blocks.map(block => block.messageId))].filter(id => !assistants.some(message => message.info.id === id))
      assistants = [...assistants, ...missing.map(id => ({ info: { id, role: 'assistant' }, parts: [] }))].map(message => {
        const parts = new Map<number, RemotePart>([
          ...message.parts.map((part, index): [number, RemotePart] => [index, part]),
          ...blocks.filter(block => block.messageId === message.info.id).map((block): [number, RemotePart] => {
            const projected = message.parts[block.ordinal]
            const text = !block.complete && projected?.type === 'text' && (projected.text?.length || 0) > block.text.length ? projected.text! : block.text
            return [block.ordinal, { id: message.info.id + ':' + block.ordinal, type: 'text', text }]
          }),
        ])
        return { ...message, parts: [...parts.entries()].sort(([a], [b]) => a - b).map(([, part]) => part) }
      })
    }
    return {
      text: assistants.flatMap(message => message.parts.filter(part => part.type === 'text').map(part => part.text || '')).join('\n'),
      tools: assistants.flatMap(message => message.parts.filter(part => part.type === 'tool').map(part => ({
        id: part.id, name: part.tool || 'tool', status: part.state?.status || '',
        title: (part.state?.title || JSON.stringify(part.state?.input || {})).slice(0, 500),
      }))).slice(-80),
      error: assistants.map(message => message.info.error?.data?.message || message.info.error?.name || '').filter(Boolean).join('\n'),
    }
  }
  async poll(): Promise<AgentSnapshot> {
    const client = this.agentServer?.client
    if (!client || !this.remoteSessionId || !this.current.running) return structuredClone(this.current)
    const generation = this.generation
    const request = this.request
    const sessionId = this.current.sessionId
    const [messages, permissions] = await Promise.all([
      client.messages(this.remoteSessionId),
      client.permissions(this.remoteSessionId),
    ])
    if (generation === this.generation && request === this.request && sessionId === this.current.sessionId) {
      this.projectedMessages = messages
      const summary = this.summarize(messages, true)
      this.current = { ...this.current, ...summary, error: summary.error || this.current.error,
        permissions: permissions.map(item => ({ id: item.id, sessionID: this.current.sessionId, permission: item.permission, patterns: item.patterns })),
      }
    }
    return structuredClone(this.current)
  }
  async reply(id: string, allow: boolean) {
    boundedText(id, 'permission ID', 100, true)
    if (typeof allow !== 'boolean') throw new Error('Invalid permission response')
    const current = await this.poll()
    if (!current.permissions.some(permission => permission.id === id)) throw new Error('Permission request expired')
    await this.agentServer!.client!.reply(this.remoteSessionId, id, allow)
  }
  async stop() {
    if (this.stopping) return
    const server = this.agentServer
    if (server?.client && this.remoteSessionId && this.current.running) {
      this.attempt++
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
      this.attempt++
      for (const server of [...this.servers.values()]) if (this.idle(server)) this.shutdownServer(server)
    }
  }
  /** Stop every server and resolve once their processes have exited. */
  dispose() {
    this.attempt++
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
    this.projectedMessages = []
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
