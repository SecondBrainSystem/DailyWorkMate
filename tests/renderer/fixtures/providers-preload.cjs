// Providers page fixture: one web provider, one Ollama node (shown on its own page), official APIs added through the mock.
const { contextBridge } = require('electron')
localStorage.setItem('i18nextLng', process.argv.includes('--providers-qa-zh') ? 'zh-CN' : 'en-US')
const calls = []
const config = { proxyHost: '127.0.0.1', proxyPort: 11434, apiKeys: [], enableApiKey: false, theme: 'light', language: 'en-US', modelMappings: {}, modelFeatureDefaults: { vision: 'auto', thinking: 'auto' } }
let providers = [
  { id: 'deepseek', name: 'DeepSeek', type: 'builtin', authType: 'userToken', apiEndpoint: 'https://chat.deepseek.com', headers: {}, enabled: true, createdAt: 0, updatedAt: 0, supportedModels: ['deepseek-v4-flash'], status: 'online' },
  { id: 'ollama-node', name: 'Ollama 10.0.0.2:11434', type: 'custom', authType: 'token', apiEndpoint: 'http://10.0.0.2:11434', headers: {}, enabled: true, createdAt: 0, updatedAt: 0, supportedModels: ['qwen3:8b'], upstreamKind: 'ollama', status: 'online' },
]
let accounts = [{ id: 'web-1', providerId: 'deepseek', name: 'Web', status: 'active', credentials: {}, createdAt: 0, updatedAt: 0 }]
contextBridge.exposeInMainWorld('electronAPI', {
  config: { get: async () => config, update: async () => true, onConfigChanged: () => () => {} },
  proxy: { getStatus: async () => ({ isRunning: true, port: 11434, host: '127.0.0.1' }), onStatusChanged: () => () => {}, start: async () => true, stop: async () => true },
  providers: {
    getAll: async () => providers, getBuiltin: async () => [providers[0]],
    update: async (id, updates) => { providers = providers.map(item => item.id === id ? { ...item, ...updates } : item); return providers.find(item => item.id === id) },
    checkStatus: async id => ({ providerId: id, status: 'online', latency: 1 }),
    updateModels: async id => { calls.push({ operation: 'updateModels', id }); return { success: true, modelsCount: 3 } },
    delete: async id => { providers = providers.filter(item => item.id !== id); return true },
  },
  accounts: { getAll: async () => accounts },
  app: {
    openExternal: async url => { calls.push({ operation: 'openExternal', url }) },
    addApiProvider: async input => {
      calls.push({ operation: 'addApiProvider', input })
      await new Promise(resolve => setTimeout(resolve, 150))
      if (input.apiKey === 'sk-bad') throw new Error("Error invoking remote method 'apiProviders:add': Error: The API key was rejected (HTTP 401): Authentication Fails")
      const id = 'api-' + input.presetId
      const existed = providers.some(item => item.id === id)
      if (!existed) providers = [...providers, { id, name: input.presetId === 'deepseek' ? 'DeepSeek' : 'Anthropic Claude', type: 'custom', authType: 'token', apiEndpoint: input.presetId === 'deepseek' ? 'https://api.deepseek.com' : 'https://api.anthropic.com', headers: {}, enabled: true, createdAt: 1, updatedAt: 1,
        description: input.presetId === 'deepseek' ? 'api.deepseek.com' : 'api.anthropic.com', supportedModels: ['deepseek-v4-flash', 'deepseek-chat', 'deepseek-reasoner'], upstreamKind: 'api', apiPreset: input.presetId, apiProtocol: input.presetId === 'anthropic' ? 'anthropic' : 'openai', status: 'online' }]
      accounts = [...accounts, { id: 'key-' + accounts.length, providerId: id, name: 'key', status: 'active', credentials: { apiKey: input.apiKey }, createdAt: 1, updatedAt: 1 }]
      return { providerId: id, accountId: 'key-' + (accounts.length - 1), models: ['deepseek-v4-flash', 'deepseek-chat', 'deepseek-reasoner'], addedKey: existed, sharedModels: ['deepseek-v4-flash'] }
    },
  },
})
contextBridge.exposeInMainWorld('providersQA', { calls: () => calls })
