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
contextBridge.exposeInMainWorld('electronAPI', {
  config: { get: async () => config, update: async updates => { config = { ...config, ...updates }; return true }, onConfigChanged: () => () => {} },
  store: { get: async key => key === 'config' ? config : [], set: async (_key, value) => { config = value } },
  proxy: { getStatus: async () => status, start: async () => true, stop: async () => true, onStatusChanged: () => () => {} },
  prompts: { getAll: async () => [prompt, translationPrompt], update: async (id, updates) => ({ ...(id === translationPrompt.id ? translationPrompt : prompt), ...updates }) },
  statistics: { get: async () => ({ dailyStats: {}, accountUsage: {} }) },
})
