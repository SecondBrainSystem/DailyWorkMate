import { app, dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import path from 'node:path'
import { IpcChannels } from '../ipc/channels'
import { CompanionStorage } from './storage'
import { OpenCodeService, runtimeExecutable } from './opencode'
import { OpenCodeTerminalService } from './terminal'
import { ClaudeCodeAgent, ClaudeCodeTerminalService } from './claudeCode'
import { terminalSpawner } from './terminalProcess'
import { TerminalClient } from '../terminal/client'
import { managedRuntimeExecutable } from './runtimeUpdates'
import { OpenCodeRuntimeUpdates } from './runtimeUpdates'
import { configureOpenCodeFreeModelCache, getOpenCodeFreeModels } from './opencodeModels'
import { SpeechService } from './speech'
import { storeManager } from '../store/store'
import { listWorkspaceFiles, readWorkspaceFile, resolveWorkspacePath } from './workspaces'
import { openLocalDirectory } from './folders'
import type { CompanionAPI, CompanionSettings, CompanionMessage, AgentInput } from '../../shared/companion'
import { agentEngine, boundedText, validateSettings, type AgentEngine } from '../../shared/companion'
import { terminalId, validateTerminalCreate, type TerminalState } from '../../shared/terminal'

let terminalManager: TerminalClient | undefined
let resetCompanionData: (() => Promise<void>) | undefined
export async function clearCompanionData() { await resetCompanionData?.() }
export function keepTerminalProxyAlive() { return terminalManager?.backgroundProxyRequired() || false }

export function registerCompanionHandlers(window: BrowserWindow, ensureProxy: () => Promise<boolean> = async () => false) {
  const storage = new CompanionStorage()
  const bundledExecutable = app.isPackaged ? path.join(process.resourcesPath, 'companion-runtime', 'opencode.exe') : runtimeExecutable(storage.home)
  const agent = new OpenCodeService(storage, () => storeManager.getConfig(), bundledExecutable)
  const claudeAgent = new ClaudeCodeAgent(storage, () => storeManager.getConfig())
  // Chat turns go to the engine that started them until it finishes.
  let activeEngine: AgentEngine = 'opencode'
  terminalManager = new TerminalClient({ home: path.join(storage.home, 'data', 'terminal'),
    entry: path.join(app.getAppPath(), 'out', 'main', 'terminalHost.js'),
    helper: app.isPackaged ? path.join(process.resourcesPath, 'companion-terminal', 'companion-pty-host.cjs') : path.join(app.getAppPath(), 'scripts', 'companion-pty-host.cjs'),
    ptyModule: app.isPackaged ? path.join(process.resourcesPath, 'companion-terminal', 'node-pty') : path.join(app.getAppPath(), 'node_modules', 'node-pty'),
    context: async () => {
      const saved = await storage.get(), config = storeManager.getConfig()
      return { workspaces: saved.workspaces, groups: saved.groups, persona: saved.settings.persona, executable: managedRuntimeExecutable(storage.home) || bundledExecutable,
        proxy: { proxyHost: config.proxyHost, proxyPort: config.proxyPort, enableApiKey: config.enableApiKey, apiKeys: config.apiKeys.filter(key => key.enabled).slice(0, 1).map(key => ({ key: key.key, enabled: true })) } }
    } })
  const manager = terminalManager
  window.on('close', event => {
    if (manager.backgroundProxyRequired()) { event.preventDefault(); window.hide() }
  })
  const baseTerminalOperations = manager.api(async () => {
    const selected = await dialog.showOpenDialog(window, { properties: ['openDirectory'] })
    return selected.canceled ? null : selected.filePaths[0] || null
  })
  const terminalOperations = { ...baseTerminalOperations, create: async (input: import('../../shared/terminal').TerminalCreateInput) => {
    const checked = validateTerminalCreate(input)
    if (checked.kind === 'opencode') {
      if (installing) throw new Error('OpenCode is updating; try again shortly')
      if (!checked.opencode!.model.startsWith('opencode-free/') && !(await ensureProxy())) throw new Error('Unable to start the model proxy. Check proxy settings and port availability.')
    }
    return baseTerminalOperations.create(checked)
  } }
  for (const [operation, channel] of Object.entries(IpcChannels.TERMINAL)) {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted terminal request')
      try { return await (terminalOperations[operation as keyof typeof terminalOperations] as (...input: unknown[]) => unknown)(...args) }
      catch (error) { const message = error instanceof Error ? error.message : 'Terminal operation failed'; console.error('[Terminal] ' + operation + ': ' + message); throw new Error(message) }
    })
  }
  void manager.neededAtStartup().then(needed => needed ? manager.synchronize() : undefined).then(async state => {
    if (!state) return
    if (state.sessions.some(session => session.kind === 'opencode' && session.status === 'running' && !session.opencode?.model.startsWith('opencode-free/')) && !(await ensureProxy())) throw new Error('Unable to start the model proxy for restored OpenCode sessions')
  }).catch(error => console.error('[Terminal] Startup:', error.message))
  const ptySpawner = () => terminalSpawner(app.isPackaged ? path.join(process.resourcesPath, 'companion-terminal', 'companion-pty-host.cjs') : path.join(app.getAppPath(), 'scripts', 'companion-pty-host.cjs'),
    app.isPackaged ? path.join(process.resourcesPath, 'companion-terminal', 'node-pty') : 'node-pty')
  const terminal = new OpenCodeTerminalService(agent, storage.home, ptySpawner)
  const claudeTerminal = new ClaudeCodeTerminalService(storage, () => storeManager.getConfig(), ptySpawner)
  const terminalFor = (id: string) => claudeTerminal.has(id) ? claudeTerminal : terminal
  const refreshAccess = async () => { await terminal.refreshAccess(); await claudeTerminal.refreshAccess() }
  resetCompanionData = async () => { await terminal.close(); await claudeTerminal.close(); await claudeAgent.stop(); const state = await manager.synchronize(); for (const session of state.sessions) await manager.command('close', { id: session.id }); await manager.command('preferences', { preferences: { ...state.preferences, restoreOnStartup: false, keepRunningOnExit: false } }); await manager.detach(); await storage.reset() }
  window.webContents.on('render-process-gone', () => { void terminal.close(); void claudeTerminal.close() })
  window.webContents.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => { if (isMainFrame) { void terminal.close(); void claudeTerminal.close() } })
  const updates = new OpenCodeRuntimeUpdates({ home: storage.home, bundledExecutable, isBusy: () => agent.isBusy() || manager.openCodeBusy(), beforeActivate: () => agent.dispose() })
  configureOpenCodeFreeModelCache(path.join(storage.home, 'data', 'opencode-models.json'))
  let installing = false
  const stopUpdates = updates.startPeriodicChecks()
  const speech = new SpeechService()
  const snapshot = async (includeAssets = true) => {
    let avatarModelUrl = '', avatarModelError = ''
    try { if (includeAssets) avatarModelUrl = await storage.avatarModelUrl() }
    catch (error) { avatarModelError = error instanceof Error ? error.message : 'Cannot load the saved 3D avatar'; console.error('[Companion] 3D avatar:', avatarModelError) }
    let avatarUrl = ''
    try { if (includeAssets) avatarUrl = await storage.avatarUrl() } catch (error) { avatarModelError ||= error instanceof Error ? error.message : 'Cannot load the saved avatar' }
    return { ...(await storage.get()), home: storage.home, avatarUrl, avatarModelUrl, assetsIncluded: includeAssets, warnings: [...storage.warnings],
      ...(avatarModelError ? { avatarModelError } : {}), runtimeAvailable: agent.available(), claudeCode: claudeAgent.status(), accessibilitySupportEnabled: app.isAccessibilitySupportEnabled() }
  }
  const operations: CompanionAPI = {
    openTerminal: async input => {
      if (input && typeof input === 'object' && agentEngine(input.engine) === 'claude') {
        if (!(await ensureProxy())) throw new Error('Unable to start the model proxy. Check proxy settings and port availability.')
        return claudeTerminal.open(input)
      }
      if (installing) throw new Error('OpenCode is updating; try again shortly')
      return terminal.open(input)
    },
    pollTerminal: async (id, cursor) => terminalFor(id).poll(id, cursor),
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
    get: snapshot,
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
      return snapshot()
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
    updateWorkspace: async (id: string, writable: boolean | null) => { await storage.updateWorkspace(id, writable); await refreshAccess(); await manager.synchronize(); return snapshot() },
    saveWorkspaceGroup: async input => { await storage.saveWorkspaceGroup(input); await refreshAccess(); await manager.synchronize(); return snapshot() },
    deleteWorkspaceGroup: async id => { await storage.deleteWorkspaceGroup(id); await refreshAccess(); await manager.synchronize(); return snapshot() },
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
      if (engine === 'claude' ? (await agent.poll()).running : claudeAgent.isBusy()) throw new Error('An agent task is already running or stopping')
      if (!input.model.startsWith('opencode-free/') && !(await ensureProxy())) throw new Error('Unable to start the model proxy. Check proxy settings and port availability.')
      const started = engine === 'claude' ? await claudeAgent.start(input) : await agent.start(input)
      activeEngine = engine
      return started
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
      try {
        return await (operations[operation as keyof CompanionAPI] as (...input: unknown[]) => unknown)(...args)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Companion operation failed'
        console.error('[Companion] ' + operation + ': ' + message)
        throw new Error(message)
      }
    })
  }
  const cleanup = () => { stopUpdates(); void terminal.close(); void claudeTerminal.close(); claudeAgent.dispose(); speech.dispose() }
  window.on('closed', () => {
    cleanup()
    void manager.detach().catch(error => console.error('[Terminal] Window closed:', error.message))
  })
  app.on('will-quit', () => {
    cleanup()
    void manager.detach().catch(error => console.error('[Terminal] Quit:', error.message))
  })
}
