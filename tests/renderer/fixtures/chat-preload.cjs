const { contextBridge } = require('electron')
const port = Number(process.argv.find(arg => arg.startsWith('--chat-qa-port='))?.split('=')[1])
if (process.argv.includes('--chat-qa-seed-legacy') && !localStorage.getItem('chat-qa-seeded')) {
  localStorage.setItem('chat-qa-seeded', 'true')
  localStorage.setItem('dailyworkmate.chat.workspace.v1', JSON.stringify({
    messages: Array.from({ length: 120 }, (_, index) => ({ id: `legacy-${index}`, role: index % 2 ? 'assistant' : 'user', content: index === 0 ? 'Legacy local conversation' : `Legacy message ${index}` })),
    model: 'qwen3-vl:qa', promptId: '', vision: 'auto', thinking: 'auto', draft: 'Legacy draft',
  }))
}
let config = {
  proxyHost: '127.0.0.1', proxyPort: port, requestTimeout: 5000, retryCount: 0,
  apiKeys: [], enableApiKey: false, modelMappings: {}, loadBalanceStrategy: 'round-robin',
  theme: 'light', language: 'en-US', modelFeatureDefaults: { vision: 'auto', thinking: 'auto' },
}
const status = { isRunning: true, port, host: '127.0.0.1', uptime: 1, connections: 0 }
const prompt = { id: 'qa-prompt', name: 'QA task', description: 'Test task', emoji: '✎', prompt: 'Summarize clearly.', type: 'system', createdAt: 0, updatedAt: 0 }
const translationPrompt = { id: 'qa-translate', name: 'QA translation', description: 'Translate text', emoji: '🌐', prompt: 'Translate faithfully.', type: 'translation', createdAt: 0, updatedAt: 0 }
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
  companion: { openCodeModels: async () => ({ models: [], stale: false, updatedAt: Date.now() }) },
  inference: createInferenceFixture(async () => port, operation => { const calls = JSON.parse(localStorage.getItem('chat-qa-api') || '[]'); localStorage.setItem('chat-qa-api', JSON.stringify([...calls, operation])) }),
  config: { get: async () => config, update: async updates => { config = { ...config, ...updates }; return true }, onConfigChanged: () => () => {} },
  store: { get: async key => key === 'config' ? config : [], set: async (_key, value) => { config = value } },
  proxy: { getStatus: async () => status, start: async () => { throw new Error('Chat must not start the public API') }, stop: async () => { throw new Error('Chat must not stop the public API') }, onStatusChanged: () => () => {} },
  prompts: { getAll: async () => [prompt, translationPrompt], update: async (id, updates) => ({ ...(id === translationPrompt.id ? translationPrompt : prompt), ...updates }) },
  statistics: { get: async () => ({ dailyStats: {}, accountUsage: {} }) },
})
