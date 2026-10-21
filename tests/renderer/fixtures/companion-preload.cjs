const { contextBridge, ipcRenderer, webUtils } = require('electron')
const qaWorkspace = process.argv.find(arg => arg.startsWith('--companion-qa-workspace='))?.slice('--companion-qa-workspace='.length)
const port = Number(process.argv.find(arg => arg.startsWith('--companion-qa-port='))?.split('=')[1])
let config = { proxyHost: '127.0.0.1', proxyPort: port, apiKeys: [], enableApiKey: false, theme: 'light', language: 'en-US' }
let state = JSON.parse(localStorage.getItem('companion-qa') || 'null') || {
  settings: { name: 'DailyWorkMate', persona: 'A reliable companion.', model: 'qa-model', autoSpeak: false, ttsMode: 'local', language: 'zh-CN', systemVoice: '', voice: 'alloy', speechRate: 1, speechVolume: 1, speechPitch: 1, readingMode: 'summary', avatar: '', avatarVisible: true, avatarMode: '2d', avatarModel: '', stt: { baseUrl: '', model: 'whisper-1', apiKey: '' }, tts: { baseUrl: '', model: 'tts-1', apiKey: '' } },
  workspaces: [], groups: [], messages: [], home: 'companion/data', avatarUrl: '', avatarModelUrl: '', runtimeAvailable: true,
}
state = { ...state, settings: { ...state.settings, systemFallback: state.settings.systemFallback ?? true, localVoice: state.settings.localVoice || 'auto', localEngine: state.settings.localEngine || 'fast' } }
const save = next => { state = next; localStorage.setItem('companion-qa', JSON.stringify(next)); return next }
// Like the main process: after a permission change, only the affected Work tabs reconnect.
const grantsChanged = async next => { if (process.argv.includes('--companion-native-terminal')) await ipcRenderer.invoke('qa:refreshAccess'); return next }
let status = { isRunning: !process.argv.includes('--companion-qa-proxy-stopped'), port, host: '127.0.0.1', uptime: 1, connections: 0 }
const allProxyModels = [{ id: 'qa-model' }, { id: 'qa-model-alt' }, { id: 'qa-model-bad' }]
// 'companion-qa-no-proxy-models' simulates every provider and Ollama node being unavailable.
const currentProxyModels = () => localStorage.getItem('companion-qa-no-proxy-models') ? [] : allProxyModels
let agent = { sessionId: 'qa-session', running: false, text: '', error: '', tools: [], permissions: [] }
let approved = false
let plainReply = ''
let phaseStep = 0
let agentSerial = 0
let recoveryFinal = ''
const toolRefusal = "I can't make that tool call. I can help with a weather lookup or a read-only database connectivity check."
const record = (operation, input) => {
  const entries = JSON.parse(localStorage.getItem('companion-qa-api') || '[]')
  localStorage.setItem('companion-qa-api', JSON.stringify([...entries, { operation, input }]))
}
let runtime = {
  currentVersion: '2.0.23', latestVersion: '', checkedAt: 0, releaseUrl: '',
  updateAvailable: false, checking: false, installing: false, error: '', source: 'bundled',
}
const freeCatalogue = {
  models: [{ id: 'opencode-free/qa-free', apiModel: 'qa-free', name: 'QA Free Native', contextLimit: 128000, outputLimit: 16000, toolCall: true }],
  updatedAt: 1791377132482, stale: false,
}
// QA-only adapter: the private deterministic HTTP fixture supplies the inference IPC contract.
function createInferenceFixture(getPort, record = () => {}, catalogue) {
  const listeners = new Set(), pending = new Map()
  const emit = event => { for (const listener of [...listeners]) listener(event) }
  return {
    onData(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    async cancel(id) { pending.get(id)?.abort(); pending.delete(id) },
    async request(input) {
      record('inference:' + input.path, input.body)
      if (input.path === '/v1/models' && catalogue) return { status: 200, headers: { 'content-type': 'application/json' }, body: { data: catalogue() } }
      const controller = new AbortController()
      pending.set(input.id, controller)
      try {
        const response = await fetch('http://127.0.0.1:' + await getPort() + input.path, {
          method: input.method, headers: { 'Content-Type': 'application/json', ...input.headers },
          ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }), signal: controller.signal,
        })
        const headers = Object.fromEntries(response.headers)
        if (!response.ok || input.path !== '/v1/chat/completions') {
          const raw = await response.text(); let body = raw
          try { body = JSON.parse(raw) } catch {}
          pending.delete(input.id)
          return { status: response.status, headers, body }
        }
        void (async () => {
          const reader = response.body.getReader(), decoder = new TextDecoder()
          try {
            for (;;) {
              const { done, value } = await reader.read()
              emit({ id: input.id, data: decoder.decode(value, { stream: !done }), ...(done ? { done: true } : {}) })
              if (done) break
            }
          } catch (error) { if (!controller.signal.aborted) emit({ id: input.id, error: String(error) }) }
          finally { pending.delete(input.id); reader.releaseLock() }
        })()
        return { status: response.status, headers, stream: true }
      } catch (error) { pending.delete(input.id); throw error }
    },
  }
}

contextBridge.exposeInMainWorld('electronAPI', {
  inference: createInferenceFixture(async () => port, record, currentProxyModels),
  getPathForFile: file => webUtils.getPathForFile(file),
  ...(process.argv.includes('--unified-terminal') ? { terminal: Object.fromEntries(['get','create','select','close','restart','poll','write','resize','savePreferences','pickDirectory','saveLayout'].map(name => [name, (...args) => ipcRenderer.invoke('qa:terminal:' + name, ...args)])) } : {}),
  app: { openExternal: async url => { record('openExternal', url); return true } },
  config: { get: async () => config, update: async updates => { config = { ...config, ...updates }; return true }, onConfigChanged: () => () => {} },
  store: { get: async key => key === 'config' ? config : [], set: async () => {} },
  proxy: {
    getStatus: async () => status,
    getModels: async () => { record('proxy:getModels'); return currentProxyModels() },
    start: async () => { record('proxy:start'); status = {...status, isRunning:true}; return true },
    stop: async () => { status = {...status, isRunning:false}; return true },
    onStatusChanged: () => () => {},
  },
  statistics: { get: async () => ({ dailyStats: {}, accountUsage: {} }) },
  companion: {
    readTodo: (id, relativePath) => ipcRenderer.invoke('qa:daily:readTodo', id, relativePath),
    setTodoTask: (id, relativePath, change) => ipcRenderer.invoke('qa:daily:setTodoTask', id, relativePath, change),
    copyTodoToday: (id, relativePath) => ipcRenderer.invoke('qa:daily:copyTodoToday', id, relativePath),
    openTerminal: input => ipcRenderer.invoke('qa:openTerminal', input),
    pollTerminal: (id, cursor) => ipcRenderer.invoke('qa:pollTerminal', id, cursor),
    writeTerminal: (id, data) => ipcRenderer.invoke('qa:writeTerminal', id, data),
    resizeTerminal: (id, cols, rows) => ipcRenderer.invoke('qa:resizeTerminal', id, cols, rows),
    closeTerminal: id => ipcRenderer.invoke('qa:closeTerminal', id),
    localSpeechStatus: async () => ({ available: true, recognitionAvailable: true, engine: 'sherpa-onnx', model: 'Kokoro v1.1 Chinese / English', fastAvailable: true, fastModel: 'Matcha Chinese', ready: true, warming: false, readyEngine: 'fast' }),
    warmupSpeech: async () => ({ available: true, recognitionAvailable: true, fastAvailable: true, ready: true, warming: false, readyEngine: 'fast' }),
    openCodeStatus: async () => { record('openCodeStatus'); return runtime },
    checkOpenCodeUpdate: async () => {
      record('checkOpenCodeUpdate')
      runtime = { ...runtime, latestVersion: '2.0.24', checkedAt: Date.now(), releaseUrl: 'https://github.com/anomalyco/opencode/tree/v2.0.24', updateAvailable: runtime.currentVersion !== '2.0.24' }
      return runtime
    },
    installOpenCodeUpdate: async () => {
      record('installOpenCodeUpdate')
      runtime = { ...runtime, currentVersion: '2.0.24', latestVersion: '2.0.24', checkedAt: Date.now(), updateAvailable: false, source: 'managed' }
      return runtime
    },
    openCodeModels: async forceRefresh => {
      record('openCodeModels', !!forceRefresh)
      const failure = localStorage.getItem('companion-qa-free-error')
      if (failure) {
        await new Promise(resolve => setTimeout(resolve, 250))
        return { ...freeCatalogue, models: failure === 'empty' ? [] : freeCatalogue.models, stale: true, error: 'QA_FREE_CATALOGUE_UNAVAILABLE' }
      }
      return localStorage.getItem('companion-qa-long-model') ? { ...freeCatalogue, models: [...freeCatalogue.models,
        { id: 'opencode-free/ling-3.1-flash-free', apiModel: 'ling-3.1-flash-free', name: 'Ling 3.1 Flash Free', contextLimit: 128000, outputLimit: 16000, toolCall: true }] } : freeCatalogue
    },
    get: async () => {
      record('companion:get')
      const delay = Number(localStorage.getItem('companion-qa-get-delay') || 0)
      if (delay) { localStorage.removeItem('companion-qa-get-delay'); await new Promise(resolve => setTimeout(resolve, delay)) }
      const change = localStorage.getItem('companion-qa-next-get-change')
      if (change) {
        localStorage.removeItem('companion-qa-next-get-change')
        if (change === 'error') throw new Error('QA_RECOVERY_REFRESH_FAILED')
        if (change === 'persona-after-first') { localStorage.setItem('companion-qa-next-get-change', 'persona'); return state }
        save(change === 'persona' ? { ...state, settings: { ...state.settings, persona: state.settings.persona + ' Updated elsewhere.' } }
          : { ...state, workspaces: state.workspaces.map(grant => grant.id === 'qa-folder' ? { ...grant, writable: !grant.writable } : grant) })
      }
      return state
    },
    saveSettings: async settings => { const result = save({ ...state, settings }); return { ...result, assetsIncluded: false, avatarUrl: '', avatarModelUrl: '', avatarModelError: undefined } },
    saveMessages: async messages => { save({ ...state, messages }) },
    openWorkspace: async (id, relativePath = '') => { record('openWorkspace', { id, relativePath }); return ipcRenderer.invoke('qa:folder:openWorkspace', id, relativePath) },
    openTerminalDirectory: async id => { record('openTerminalDirectory', id); return ipcRenderer.invoke('qa:folder:openTerminalDirectory', id) },
    inspectFolders: paths => ipcRenderer.invoke('qa:folder:inspectFolders', paths),
    importWorkspaces: async input => { const next = await ipcRenderer.invoke('qa:folder:importWorkspaces', input); return save({ ...state, workspaces: next.workspaces, groups: next.groups }) },
    addWorkspace: async () => { const count = state.workspaces.length; return save({ ...state, workspaces: [...state.workspaces, { id: count ? 'qa-folder-' + count : 'qa-folder', path: count ? (qaWorkspace || 'C:/QA/project') + '-' + count : qaWorkspace || 'C:/QA/project', name: count ? 'Project ' + count : 'Project', writable: false }] }) },
    updateWorkspace: async (id, writable) => grantsChanged(save({ ...state, workspaces: writable === null ? state.workspaces.filter(grant => grant.id !== id) : state.workspaces.map(grant => grant.id === id ? { ...grant, writable } : grant) })),
    saveWorkspaceGroup: async input => { record('saveWorkspaceGroup', input); const group = { ...input, id: input.id || 'qa-group-' + Date.now() }; return save({ ...state, groups: [...state.groups.filter(item => item.id !== group.id), group] }) },
    deleteWorkspaceGroup: async id => { record('deleteWorkspaceGroup', id); return save({ ...state, groups: state.groups.filter(group => group.id !== id) }) },
    pickAvatar: async () => save({ ...state, settings: { ...state.settings, avatar: 'avatar.png' }, avatarUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAABmJLR0QA/wD/AP+gvaeTAAAAFElEQVQImWP8z8Dwn4GBgYGJAQoAHxcCAr7cGDwAAAAASUVORK5CYII=' }),
    resetAvatar: async () => save({ ...state, settings: { ...state.settings, avatar: '' }, avatarUrl: '' }),
    pickAvatarModel: async () => { record('pickAvatarModel'); const response = await fetch('http://127.0.0.1:' + port + '/qa-avatar'); return save({ ...state, settings: { ...state.settings, avatarMode: '3d', avatarModel: 'qa-model.glb', avatarVisible: true }, avatarModelUrl: await response.text() }) },
    resetAvatarModel: async () => { record('resetAvatarModel'); return save({ ...state, settings: { ...state.settings, avatarMode: '3d', avatarModel: '' }, avatarModelUrl: '', avatarModelError: undefined }) },
    listFiles: async (id, relativePath = '') => process.argv.includes('--daily-todo-qa')
      ? ipcRenderer.invoke('qa:daily:listFiles', id, relativePath)
      : relativePath ? [{ name: 'nested', relativePath: relativePath + '/nested', directory: true }, { name: 'notes.txt', relativePath: relativePath + '/notes.txt', directory: false }] : [{ name: 'docs', relativePath: 'docs', directory: true }, { name: 'notes.txt', relativePath: 'notes.txt', directory: false }],
    readFile: async (id, relativePath) => process.argv.includes('--daily-todo-qa') ? ipcRenderer.invoke('qa:daily:readFile', id, relativePath) : 'ATTACHMENT_QA',
    cancelSpeech: async () => {},
    transcribe: async () => 'VOICE_QA',
    synthesize: async () => { throw new Error('Local speech resources unavailable in this fixture') },
    startAgent: async input => {
      record('startAgent', input)
      approved = false
      plainReply = ''
      phaseStep = 0
      recoveryFinal = ''
      const sessionId = input.sessionId || 'v2:s0123456789abcdef:session-' + Date.now() + '-' + ++agentSerial
      if (input.prompt.startsWith('RECOVERY_')) {
        agent = { sessionId, running: false, text: toolRefusal, error: '', tools: [], permissions: [] }
        if (input.model === 'qa-model-alt' && !input.prompt.startsWith('RECOVERY_REPEAT')) {
          agent = { ...agent, text: 'RECOVERY_QA_COMPLETE', tools: [{ id: 'qa-recovered-read', name: 'read', status: 'completed', title: 'notes.txt' }] }
          if (input.prompt.startsWith('RECOVERY_RETRY_WAIT')) agent = { ...agent, running: true, text: '', tools: [] }
        } else if (input.prompt.startsWith('RECOVERY_ERROR')) agent = { ...agent, error: 'QA_RECOVERY_UPSTREAM_ERROR' }
        else if (input.prompt.startsWith('RECOVERY_CANCEL')) agent = { ...agent, running: true }
        else if (input.prompt.startsWith('RECOVERY_TOOLS') || input.prompt.startsWith('RECOVERY_PERMISSION')) {
          recoveryFinal = toolRefusal
          agent = { ...agent, running: true, text: '', ...(input.prompt.startsWith('RECOVERY_TOOLS')
            ? { tools: [{ id: 'qa-temporary-tool', name: 'read', status: 'running', title: 'notes.txt' }] }
            : { permissions: [{ id: 'qa-temporary-permission', sessionID: sessionId, permission: 'read', patterns: ['notes.txt'] }] }) }
        }
      } else if (!input.workspaceId) {
        plainReply = input.prompt === 'VOICE_LONG_QA' ? '这是需要完整朗读的详细说明。'.repeat(1200) + '全文结束标记。' : input.prompt === 'SUMMARY_WAIT_QA' ? 'SUMMARY_WAIT_QA。' + '这是需要等待摘要的回答。'.repeat(60) : input.model === 'opencode-free/qa-free' ? 'FREE_PLAIN_QA_COMPLETE' : 'Hello from your companion. CHAT_QA_COMPLETE'
        agent = { sessionId, running: true, text: 'Hello from your companion. ', error: '', tools: [], permissions: [] }
        if (input.prompt === 'WAIT_QA') plainReply = ''
        if (input.prompt === 'PHASE_QA') { plainReply = ''; phaseStep = 1; agent = { ...agent, text: '', phase: 'thinking' } }
      }
      else if (input.prompt.startsWith('QA_GROUP')) agent = { sessionId, running: false, text: input.prompt + '_REPLY', error: '', tools: [{ id: 'qa-read', name: 'read', status: 'completed', title: 'notes.txt' }], permissions: [] }
      else if (input.prompt.includes('QA_NO_TOOLS')) agent = { sessionId, running: false, text: 'QA_NO_TOOLS_REPLY: I cannot access that folder.', error: '', tools: [], permissions: [] }
      else if (input.prompt.includes('QA_AGENT_ERROR')) agent = { sessionId, running: false, text: '', error: 'QA_UPSTREAM_ACCESS_DENIED', tools: [], permissions: [] }
      else if (input.model === 'opencode-free/qa-free') agent = { sessionId, running: false, text: 'FREE_NATIVE_QA_COMPLETE: notes.txt', error: '', tools: [{ id: 'qa-native-read', name: 'read', status: 'completed', title: 'notes.txt' }], permissions: [] }
      else agent = { sessionId, running: true, text: 'Working on the authorized folder', error: '', tools: [{ id: 'qa-tool', name: 'bash', status: 'running', title: 'echo QA' }], permissions: [{ id: 'qa-permission', sessionID: sessionId, permission: 'bash', patterns: ['echo QA'] }] }
      return agent
    },
    pollAgent: async () => {
      if (recoveryFinal) { agent = { ...agent, running: false, text: recoveryFinal, tools: [], permissions: [] }; recoveryFinal = '' }
      if (phaseStep) {
        phaseStep++
        agent = phaseStep <= 12 ? { ...agent, phase: phaseStep <= 4 ? 'thinking' : phaseStep <= 8 ? 'tool' : 'responding' }
          : { ...agent, running: false, text: 'PHASE_QA_COMPLETE', phase: undefined }
        if (!agent.running) phaseStep = 0
      }
      if (plainReply) { agent = { ...agent, running: false, text: plainReply }; plainReply = '' }
      if (approved) agent = { ...agent, running: false, text: 'AGENT_QA_COMPLETE', tools: agent.tools.map(tool => ({ ...tool, status: 'completed' })), permissions: [] }
      return agent
    },
    stopAgent: async id => { record('stopAgent', id); plainReply = ''; phaseStep = 0; recoveryFinal = ''; agent = { ...agent, running: false, permissions: [] } },
    replyPermission: async (_id, allow) => { approved = allow },
  },
})
