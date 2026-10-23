// Documentation-only fixture: real renderer with clearly identified, non-personal demo data.
const { contextBridge, ipcRenderer } = require('electron')
const fs = require('node:fs')
const file = process.argv.find(value => value.startsWith('--readme-data=')).slice('--readme-data='.length)
const data = JSON.parse(fs.readFileSync(file, 'utf8'))
let snapshot = data.snapshot
let config = data.config
localStorage.setItem('i18nextLng', 'zh-CN')
localStorage.setItem('dailyworkmate-settings', JSON.stringify({ state: { theme: 'light', language: 'zh-CN', sidebarCollapsed: false }, version: 0 }))
localStorage.setItem('dailyworkmate.companion.view', 'chat')
const terminal = Object.fromEntries(['get', 'create', 'select', 'close', 'restart', 'poll', 'write', 'resize', 'savePreferences', 'pickDirectory'].map(name => [name, (...args) => ipcRenderer.invoke('readme:terminal:' + name, ...args)]))
const save = next => { snapshot = next; return next }
const speech = { available: true, recognitionAvailable: true, fastAvailable: true, ready: true, warming: false, readyEngine: 'fast' }
// Synthetic usage for documentation screenshots; no model requests are made.
const demoModels = ['qwen3:32b', 'deepseek-v3', 'claude-sonnet', 'glm-4.7']
const demoDays = Array.from({ length: 100 }, (_, index) => {
  const date = new Date(); date.setDate(date.getDate() - 99 + index)
  const key = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-')
  const totalTokens = index % 9 === 0 ? 0 : Math.floor((Math.sin(index * .72) + 1.4) * 34000 + index * 1300)
  return { date: key, totalTokens, totalRequests: totalTokens ? 40 : 0, successRequests: totalTokens ? 39 : 0, failedRequests: totalTokens ? 1 : 0, totalLatency: totalTokens ? 39 * 1250 : 0,
    modelTokenUsage: Object.fromEntries(demoModels.map((model, i) => [model, Math.floor(totalTokens * (4 - i) / 10)])),
    modelUsage: Object.fromEntries(demoModels.map((model, i) => [model, totalTokens ? (4 - i) * 4 : 0])) }
})
const demoLogs = demoModels.map((model, index) => ({ id: 'demo-' + index, timestamp: Date.now() - index * 120000, status: 'success', model, latency: 1200 + index * 250, providerName: index ? 'API' : 'Ollama', method: 'POST', url: '/v1/chat/completions', responseStatus: 200, isStream: true }))
contextBridge.exposeInMainWorld('electronAPI', {
  app: { getVersion: async () => data.version, openExternal: async () => false },
  config: { get: async () => config, update: async updates => { config = { ...config, ...updates }; return true }, onConfigChanged: () => () => {} },
  store: { get: async key => key === 'config' ? config : [] },
  proxy: { getStatus: async () => ({ isRunning: true, host: '127.0.0.1', port: config.proxyPort }), getModels: async () => [{ id: 'Demo model' }], onStatusChanged: () => () => {} },
  statistics: { get: async () => ({ dailyStatsAvailableFrom: demoDays[0].date, dailyStats: Object.fromEntries(demoDays.map(day => [day.date, day])), accountUsage: {} }) },
  requestLogs: { get: async () => demoLogs, onNewLog: () => () => {} },
  terminal,
  companion: {
    get: async () => snapshot,
    saveSettings: async updates => save({ ...snapshot, settings: { ...snapshot.settings, ...updates } }),
    saveMessages: async messages => save({ ...snapshot, messages }),
    localSpeechStatus: async () => speech, warmupSpeech: async () => speech,
    openCodeStatus: async () => ({ currentVersion: '2.0.24', latestVersion: '', checkedAt: 0, releaseUrl: '', updateAvailable: false, checking: false, installing: false, error: '', source: 'bundled' }),
    openCodeModels: async () => ({ models: [], updatedAt: Date.now(), stale: false }),
    cancelSpeech: async () => {},
    listFiles: async () => [{ name: 'daily-todo.md', relativePath: 'daily-todo.md', directory: false }, { name: 'weekly-plan.md', relativePath: 'weekly-plan.md', directory: false }, { name: 'meeting-notes.md', relativePath: 'meeting-notes.md', directory: false }],
    readTodo: async () => ({ content: data.todo, revision: 'demo' }),
    readFile: async () => '# Weekly plan\nPrepare a brief, review notes, and choose next steps.\n',
  },
})
