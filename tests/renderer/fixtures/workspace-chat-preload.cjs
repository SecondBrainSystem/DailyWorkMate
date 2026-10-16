// Dedicated workspace-chat QA bridge. State and filesystem operations live in the
// isolated test main process, so both pages exercise the actual IPC boundary.
const { contextBridge, ipcRenderer } = require('electron')
const invoke = (domain, action, ...args) => ipcRenderer.invoke('workspace-chat-qa:' + domain + ':' + action, ...args)
const methods = (domain, names) => Object.fromEntries(names.map(name => [name, (...args) => invoke(domain, name, ...args)]))

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
  inference: createInferenceFixture(async () => (await invoke('config', 'get')).proxyPort),
  app: methods('app', ['openExternal']),
  config: { ...methods('config', ['get', 'update']), onConfigChanged: () => () => {} },
  store: methods('store', ['get', 'set']),
  proxy: { ...methods('proxy', ['getStatus', 'getModels', 'start', 'stop']), onStatusChanged: () => () => {} },
  prompts: methods('prompts', ['getAll', 'update']),
  providers: methods('providers', ['getAll', 'getEffectiveModels']),
  accounts: methods('accounts', ['getAll']),
  statistics: methods('statistics', ['get']),
  companion: methods('companion', [
    'get', 'saveSettings', 'saveMessages', 'addWorkspace', 'updateWorkspace',
    'saveWorkspaceGroup', 'deleteWorkspaceGroup', 'listFiles', 'readFile',
    'startAgent', 'pollAgent', 'stopAgent', 'replyPermission',
    'openCodeStatus', 'checkOpenCodeUpdate', 'installOpenCodeUpdate', 'openCodeModels',
    'localSpeechStatus', 'warmupSpeech', 'cancelSpeech', 'synthesize', 'transcribe',
    'pickAvatar', 'pickAvatarModel', 'resetAvatar', 'resetAvatarModel',
  ]),
})
