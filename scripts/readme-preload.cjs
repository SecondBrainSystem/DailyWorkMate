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
contextBridge.exposeInMainWorld('electronAPI', {
  app: { getVersion: async () => data.version, openExternal: async () => false },
  config: { get: async () => config, update: async updates => { config = { ...config, ...updates }; return true }, onConfigChanged: () => () => {} },
  store: { get: async key => key === 'config' ? config : [] },
  proxy: { getStatus: async () => ({ isRunning: true, host: '127.0.0.1', port: config.proxyPort }), getModels: async () => [{ id: 'Demo model' }], onStatusChanged: () => () => {} },
  statistics: { get: async () => ({ dailyStats: {}, accountUsage: {} }) },
  terminal,
  companion: {
    get: async () => snapshot,
    saveSettings: async updates => save({ ...snapshot, settings: { ...snapshot.settings, ...updates } }),
    saveMessages: async messages => save({ ...snapshot, messages }),
    localSpeechStatus: async () => speech, warmupSpeech: async () => speech,
    openCodeStatus: async () => ({ currentVersion: '2.0.24', latestVersion: '', checkedAt: 0, releaseUrl: '', updateAvailable: false, checking: false, installing: false, error: '', source: 'bundled' }),
    openCodeModels: async () => ({ models: [], updatedAt: Date.now(), stale: false }),
    cancelSpeech: async () => {},
    listFiles: async () => [{ name: 'weekly-plan.md', relativePath: 'weekly-plan.md', directory: false }, { name: 'meeting-notes.md', relativePath: 'meeting-notes.md', directory: false }],
    readFile: async () => '# Weekly plan\nPrepare a brief, review notes, and choose next steps.\n',
  },
})
