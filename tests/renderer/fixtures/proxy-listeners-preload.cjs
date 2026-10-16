const { contextBridge } = require('electron')
localStorage.setItem('i18nextLng', 'en-US')
let failSave = false, failPort = null
let calls = []
const configListeners = new Set(), statusListeners = new Set()
let config = JSON.parse(localStorage.getItem('proxy-listeners-qa-config') || 'null') || {
  proxyHost: '127.0.0.1', proxyPort: 32123, additionalProxyListeners: [], retryCount: 3, requestTimeout: 60000,
  apiKeys: [], enableApiKey: false, theme: 'light', language: 'en-US',
  autoStart: false, autoStartProxy: false, minimizeToTray: true, oauthProxyMode: 'system',
  logLevel: 'info', logRetentionDays: 30, modelMappings: {}, loadBalanceStrategy: 'round-robin',
  modelFeatureDefaults: { vision: 'auto', thinking: 'auto' },
  requestLogConfig: { enabled: true, maxEntries: 200, includeBodies: false, maxBodyChars: 8000, redactSensitiveData: true },
}
let active = JSON.parse(localStorage.getItem('proxy-listeners-qa-active') || 'null') || [{ host: '127.0.0.1', port: 32123 }]
const status = () => ({
  host: config.proxyHost, port: config.proxyPort, isRunning: active.length > 0, uptime: 10, connections: 0,
  listeners: active.map(endpoint => ({ ...endpoint, isRunning: true, uptime: 10, connections: 0 })),
})
const emit = () => {
  localStorage.setItem('proxy-listeners-qa-active', JSON.stringify(active))
  for (const listener of statusListeners) listener(status())
}
contextBridge.exposeInMainWorld('electronAPI', {
  config: {
    get: async () => config,
    update: async updates => {
      calls = [...calls, { action: 'save', updates }]
      if (failSave) throw new Error('QA disk write failed')
      config = { ...config, ...updates }
      localStorage.setItem('proxy-listeners-qa-config', JSON.stringify(config))
      for (const listener of configListeners) listener(config)
      return true
    },
    onConfigChanged: listener => { configListeners.add(listener); return () => configListeners.delete(listener) },
  },
  proxy: {
    getStatus: async () => status(),
    start: async (port = config.proxyPort, host = config.proxyHost) => {
      calls = [...calls, { action: 'start', port, host }]
      if (port === failPort) throw new Error(`QA port ${port} is in use`)
      if (!active.some(endpoint => endpoint.port === port && endpoint.host === host)) active = [...active, { port, host }]
      emit(); return true
    },
    stop: async (port, host) => {
      calls = [...calls, { action: 'stop', port, host }]
      active = port === undefined ? [] : active.filter(endpoint => endpoint.port !== port || endpoint.host !== host)
      emit(); return true
    },
    onStatusChanged: listener => { statusListeners.add(listener); return () => statusListeners.delete(listener) },
  },
})
contextBridge.exposeInMainWorld('proxyListenersQA', {
  failSave: value => { failSave = value },
  failPort: value => { failPort = value },
  snapshot: () => ({ config, calls, active }),
})
