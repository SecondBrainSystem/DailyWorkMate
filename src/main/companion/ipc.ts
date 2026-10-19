import { app, dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import path from 'node:path'
import { readdir } from 'node:fs/promises'
import { IpcChannels } from '../ipc/channels'
import { CompanionStorage } from './storage'
import { OpenCodeService, runtimeExecutable } from './opencode'
import { OpenCodeTerminalService } from './terminal'
import { ClaudeCodeAgent, ClaudeCodeTerminalService } from './claudeCode'
import { closeAllTerminalProcesses, terminalSpawner } from './terminalProcess'
import { shouldCloseWorkTerminalsForNavigation } from './terminalLifecycle'
import { TerminalClient } from '../terminal/client'
import { managedRuntimeExecutable } from './runtimeUpdates'
import { startReapingStaleProcesses } from './processRegistry'
import { OpenCodeRuntimeUpdates } from './runtimeUpdates'
import { configureOpenCodeFreeModelCache, getOpenCodeFreeModels } from './opencodeModels'
import { SpeechService } from './speech'
import { storeManager } from '../store/store'
import { resolveModelConnection } from '../inference/modelConnection'
import { listWorkspaceFiles, readWorkspaceFile, resolveWorkspacePath } from './workspaces'
import { openLocalDirectory } from './folders'
import type { CompanionAPI, CompanionSettings, CompanionMessage, AgentInput, CompanionGetOptions } from '../../shared/companion'
import { agentEngine, boundedText, validateSettings, type AgentEngine } from '../../shared/companion'
import { terminalId, validateTerminalCreate, type TerminalState } from '../../shared/terminal'

let terminalManager: TerminalClient | undefined
let resetCompanionData: (() => Promise<void>) | undefined
export async function clearCompanionData() { await resetCompanionData?.() }
let closeCompanion: (() => Promise<void>) | undefined
export async function shutdownCompanion() { await closeCompanion?.() }
let companionHome: string | undefined
export async function companionPsmuxDirectories() {
  if (!companionHome) return []
  const directories = [path.join(companionHome, 'data', 'opencode-v2', 'home', '.psmux')]
  const profiles = path.join(companionHome, 'data', 'terminal', 'opencode')
  try {
    for (const directory of await readdir(profiles, { withFileTypes: true })) {
      if (directory.isDirectory() && /^[a-f0-9-]{32,36}$/.test(directory.name)) directories.push(path.join(profiles, directory.name, 'data', 'opencode-v2', 'home', '.psmux'))
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  return directories
}

export function registerCompanionHandlers(window: BrowserWindow) {
  const storage = new CompanionStorage()
  companionHome = storage.home
  // Helpers left by a crashed run are stopped before any new one starts (launches wait for this).
  void startReapingStaleProcesses(storage.home)
  const bundledExecutable = app.isPackaged ? path.join(process.resourcesPath, 'companion-runtime', 'opencode.exe') : runtimeExecutable(storage.home)
  const agent = new OpenCodeService(storage, () => storeManager.getConfig(), bundledExecutable, model => resolveModelConnection(model, 'opencode'))
  const claudeAgent = new ClaudeCodeAgent(storage, () => storeManager.getConfig(), undefined, model => resolveModelConnection(model, 'claude'))
  // Chat turns go to the engine that started them until it finishes.
  let activeEngine: AgentEngine = 'opencode'
  terminalManager = new TerminalClient({ home: path.join(storage.home, 'data', 'terminal'),
    entry: path.join(app.getAppPath(), 'out', 'main', 'terminalHost.js'),
    helper: app.isPackaged ? path.join(process.resourcesPath, 'companion-terminal', 'companion-pty-host.cjs') : path.join(app.getAppPath(), 'scripts', 'companion-pty-host.cjs'),
    ptyModule: app.isPackaged ? path.join(process.resourcesPath, 'companion-terminal', 'node-pty') : path.join(app.getAppPath(), 'node_modules', 'node-pty'),
    context: async models => {
      const saved = await storage.get()
      const connections = await Promise.all(models.filter(model => !model.startsWith('opencode-free/')).map(async model => {
        try { return { model, connection: await resolveModelConnection(model, 'opencode') } }
        catch (error) {
          const message = error instanceof Error ? error.message : 'Unable to connect to the selected model'
          console.error('[Terminal] Model connection:', message)
          return { model, error: message }
        }
      }))
      return { workspaces: saved.workspaces, groups: saved.groups, persona: saved.settings.persona, executable: managedRuntimeExecutable(storage.home) || bundledExecutable,
        modelConnections: Object.fromEntries(connections.flatMap(result => result.connection ? [[result.model, result.connection]] : [])),
        modelConnectionErrors: Object.fromEntries(connections.flatMap(result => result.error ? [[result.model, result.error]] : [])) }
    } })
  const manager = terminalManager
  const baseTerminalOperations = manager.api(async () => {
    const selected = await dialog.showOpenDialog(window, { properties: ['openDirectory'] })
    return selected.canceled ? null : selected.filePaths[0] || null
  })
  const terminalOperations = { ...baseTerminalOperations, create: async (input: import('../../shared/terminal').TerminalCreateInput) => {
    const checked = validateTerminalCreate(input)
    if (checked.kind === 'opencode') {
      if (installing) throw new Error('OpenCode is updating; try again shortly')
    }
    return baseTerminalOperations.create(checked)
  } }
  for (const [operation, channel] of Object.entries(IpcChannels.TERMINAL)) {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted terminal request')
      if (app.isQuitting) throw new Error('软件正在退出。 / The application is quitting.')
      try { return await (terminalOperations[operation as keyof typeof terminalOperations] as (...input: unknown[]) => unknown)(...args) }
      catch (error) { const message = error instanceof Error ? error.message : 'Terminal operation failed'; console.error('[Terminal] ' + operation + ': ' + message); throw new Error(message) }
    })
  }
  void manager.neededAtStartup().then(needed => needed && !app.isQuitting ? manager.synchronize() : undefined).catch(error => console.error('[Terminal] Startup:', error.message))
  const ptySpawner = () => terminalSpawner(app.isPackaged ? path.join(process.resourcesPath, 'companion-terminal', 'companion-pty-host.cjs') : path.join(app.getAppPath(), 'scripts', 'companion-pty-host.cjs'),
    app.isPackaged ? path.join(process.resourcesPath, 'companion-terminal', 'node-pty') : 'node-pty')
  const terminal = new OpenCodeTerminalService(agent, storage.home, ptySpawner)
  const claudeTerminal = new ClaudeCodeTerminalService(storage, () => storeManager.getConfig(), ptySpawner, undefined, model => resolveModelConnection(model, 'claude'))
  const terminalFor = (id: string) => claudeTerminal.has(id) ? claudeTerminal : terminal
  const refreshAccess = async () => { await terminal.refreshAccess(); await claudeTerminal.refreshAccess() }
  resetCompanionData = async () => { await terminal.close(); await claudeTerminal.close(); await claudeAgent.stop(); const state = await manager.synchronize(); for (const session of state.sessions) await manager.command('close', { id: session.id }); await manager.command('preferences', { preferences: { ...state.preferences, restoreOnStartup: false, keepRunningOnExit: false } }); await manager.detach(); await storage.reset() }
  window.webContents.on('render-process-gone', () => { void terminal.close(); void claudeTerminal.close() })
  window.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (shouldCloseWorkTerminalsForNavigation(isInPlace, isMainFrame)) { void terminal.close(); void claudeTerminal.close() }
  })
  const updates = new OpenCodeRuntimeUpdates({ home: storage.home, bundledExecutable, isBusy: () => agent.isBusy() || manager.openCodeBusy(), beforeActivate: () => agent.dispose() })
  configureOpenCodeFreeModelCache(path.join(storage.home, 'data', 'opencode-models.json'))
  let installing = false
  const stopUpdates = updates.startPeriodicChecks()
  const speech = new SpeechService()
  /** Avatar images (up to ~27 MB encoded) and legacy messages are sent only when asked for. */
  const snapshot = async (includeAssets = true) => {
    let avatarModelUrl = '', avatarModelError = ''
    try { if (includeAssets) avatarModelUrl = await storage.avatarModelUrl() }
    catch (error) { avatarModelError = error instanceof Error ? error.message : 'Cannot load the saved 3D avatar'; console.error('[Companion] 3D avatar:', avatarModelError) }
    let avatarUrl = ''
    try { if (includeAssets) avatarUrl = await storage.avatarUrl() }
    catch (error) { avatarModelError ||= error instanceof Error ? error.message : 'Cannot load the saved avatar'; console.error('[Companion] Avatar:', avatarModelError) }
    const saved = await storage.get()
    return { ...saved, messages: includeAssets ? saved.messages : [], home: storage.home, avatarUrl, avatarModelUrl, assetsIncluded: includeAssets, warnings: [...storage.warnings],
      ...(avatarModelError ? { avatarModelError } : {}), runtimeAvailable: agent.available(), claudeCode: claudeAgent.status(), accessibilitySupportEnabled: app.isAccessibilitySupportEnabled() }
  }
  const operations: CompanionAPI = {
    openTerminal: async input => {
      if (!input || typeof input !== 'object') throw new Error('Invalid terminal request')
      boundedText(input.model, 'model', 300, true)
      if (agentEngine(input.engine) === 'claude') {
        return claudeTerminal.open(input)
      }
      if (installing) throw new Error('OpenCode is updating; try again shortly')
      return terminal.open(input)
    },
    pollTerminal: async (id, cursor) => terminalFor(id).poll(id, cursor),
    reconnectTerminal: async (id, cols, rows) => {
      if (claudeTerminal.has(id)) {
        const current = claudeTerminal.poll(id, 0)
        if (current.starting) return current
        if (!current.running) throw new Error('Claude Code 已退出，无法接回原进程。请重新启动终端；先前任务不会自动继续。 / Claude Code has exited. Start the terminal again; the previous task cannot resume automatically.')
        claudeTerminal.resize(id, cols, rows)
        return claudeTerminal.poll(id, current.cursor)
      }
      return terminal.reconnect(id, cols, rows)
    },
    writeTerminal: async (id, data) => terminalFor(id).write(id, data),
    resizeTerminal: async (id, cols, rows) => terminalFor(id).resize(id, cols, rows),
    closeTerminal: async id => { await claudeTerminal.close(id); await terminal.close(id) },
    openCodeStatus: () => updates.status(),
    checkOpenCodeUpdate: () => updates.check(true),
    installOpenCodeUpdate: async () => {
      if (installing || agent.isBusy() || manager.openCodeBusy()) throw new Error('请等待当前工作任务结束后更新 OpenCode。 / Finish the current task before updating OpenCode.')
      installing = true
      try { return await updates.install() } finally { installing = false }
    },
    openCodeModels: (forceRefresh = false) => {
      if (typeof forceRefresh !== 'boolean') throw new Error('Invalid model refresh request')
      return getOpenCodeFreeModels(forceRefresh)
    },
    get: async (options?: CompanionGetOptions) => {
      if (options !== undefined && (!options || typeof options !== 'object' || (options.assets !== undefined && typeof options.assets !== 'boolean'))) throw new Error('Invalid companion request')
      return snapshot(options?.assets ?? true)
    },
    saveSettings: async (settings: CompanionSettings) => { await storage.saveSettings(settings); return snapshot(false) },
    saveMessages: (messages: CompanionMessage[]) => storage.saveMessages(messages),
    pickAvatar: async () => {
      const result = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }] })
      if (!result.canceled && result.filePaths[0]) await storage.setAvatar(result.filePaths[0])
      return snapshot()
    },
    pickAvatarModel: async () => {
      const result = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: '3D model (GLB)', extensions: ['glb'] }] })
      if (!result.canceled && result.filePaths[0]) await storage.setAvatarModel(result.filePaths[0])
      return snapshot()
    },
    resetAvatar: async () => { await storage.resetAvatar(); return snapshot() },
    resetAvatarModel: async () => { await storage.resetAvatarModel(); return snapshot() },
    addWorkspace: async () => {
      const result = await dialog.showOpenDialog(window, { properties: ['openDirectory'] })
      if (!result.canceled && result.filePaths[0]) { await storage.addWorkspace(result.filePaths[0]); await refreshAccess(); await manager.synchronize() }
      return snapshot(false)
    },
    inspectFolders: paths => storage.inspectFolders(paths),
    importWorkspaces: async input => { await storage.importWorkspaces(input); await refreshAccess(); await manager.synchronize(); return snapshot(false) },
    openWorkspace: async (id, relativePath = '') => openLocalDirectory(await resolveWorkspacePath(await storage.grant(id), relativePath), directory => shell.openPath(directory)),
    openTerminalDirectory: async id => {
      const checked = terminalId(id)
      const state: TerminalState = await manager.command('state')
      const session = state.sessions.find(item => item.id === checked)
      if (!session) throw new Error('终端已关闭。 / This terminal is closed.')
      await openLocalDirectory(session.directory, directory => shell.openPath(directory))
    },
    // Only Work tabs whose folder permissions changed reconnect; the rest keep running.
    updateWorkspace: async (id: string, writable: boolean | null) => { await storage.updateWorkspace(id, writable); await refreshAccess(); await manager.synchronize(); return snapshot(false) },
    saveWorkspaceGroup: async input => { await storage.saveWorkspaceGroup(input); await refreshAccess(); await manager.synchronize(); return snapshot(false) },
    deleteWorkspaceGroup: async id => { await storage.deleteWorkspaceGroup(id); await refreshAccess(); await manager.synchronize(); return snapshot(false) },
    listFiles: async (id: string, relativePath: string) => listWorkspaceFiles(await storage.grant(id), relativePath),
    readFile: async (id: string, relativePath: string) => readWorkspaceFile(await storage.grant(id), relativePath),
    transcribe: async (audio: Uint8Array, mime: string) => speech.transcribe((await storage.get()).settings, audio, mime),
    synthesize: async (text: string, settings?: CompanionSettings) => speech.synthesize(settings ? validateSettings(settings) : (await storage.get()).settings, text),
    cancelSpeech: async () => speech.cancel(),
    localSpeechStatus: () => speech.localStatus(),
    warmupSpeech: async () => speech.warmup((await storage.get()).settings),
    startAgent: async (input: AgentInput) => {
      if (installing) throw new Error('OpenCode 正在更新，请稍后再试。 / OpenCode is updating; try again shortly.')
      if (!input || typeof input !== 'object') throw new Error('Invalid agent request')
      boundedText(input.model, 'model', 300, true)
      boundedText(input.prompt, 'task', 2_000_000, true)
      if (input.systemPrompt !== undefined) boundedText(input.systemPrompt, 'system prompt', 100000)
      const engine = agentEngine(input.engine)
      // One chat task at a time across engines; OpenCode's attached Work tabs do not count.
      if (agent.agentBusy() || claudeAgent.isBusy()) throw new Error('An agent task is already running or stopping')
      // Route stop requests to this engine while it is still starting, so startup can be cancelled.
      activeEngine = engine
      return engine === 'claude' ? claudeAgent.start(input) : agent.start(input)
    },
    pollAgent: () => activeEngine === 'claude' ? claudeAgent.poll() : agent.poll(),
    stopAgent: () => activeEngine === 'claude' ? claudeAgent.stop() : agent.stop(),
    replyPermission: (id: string, allow: boolean) => activeEngine === 'claude' ? claudeAgent.reply(id, allow) : agent.reply(id, allow),
  }
  const channels = Object.entries(IpcChannels.COMPANION)
  for (const [operation, channel] of channels) {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted companion request')
      if (app.isQuitting) throw new Error('软件正在退出。 / The application is quitting.')
      try {
        return await (operations[operation as keyof CompanionAPI] as (...input: unknown[]) => unknown)(...args)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Companion operation failed'
        console.error('[Companion] ' + operation + ': ' + message)
        throw new Error(message)
      }
    })
  }
  let cleaning: Promise<void> | undefined
  // Runs once the quit is committed (or the window is gone); every step runs even if another fails.
  const cleanup = () => cleaning ||= (async () => {
    const results = await Promise.allSettled([(async () => stopUpdates())(), (async () => speech.dispose())(),
      terminal.close(), claudeTerminal.close(), claudeAgent.stop(), manager.detach(), closeAllTerminalProcesses()])
    const failures = results.filter(result => result.status === 'rejected')
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Unable to stop all companion processes')
  })().catch(error => { cleaning = undefined; throw error })
  closeCompanion = cleanup
  window.on('closed', () => {
    void cleanup().catch(error => console.error('[Companion] Window closed:', error))
  })
}
