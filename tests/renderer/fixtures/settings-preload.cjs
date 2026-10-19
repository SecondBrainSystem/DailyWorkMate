const { contextBridge } = require('electron')
localStorage.setItem('i18nextLng', 'en-US')
let fail = false, running = true
const calls = [], listeners = new Set()
const defaults = {
  proxyHost:'127.0.0.1', proxyPort:11434, retryCount:3, requestTimeout:60000,
  apiKeys:[], enableApiKey:false, theme:'light', language:'en-US',
  autoStart:false, autoStartProxy:false, minimizeToTray:true, oauthProxyMode:'system',
  logLevel:'info', logRetentionDays:30, modelMappings:{}, loadBalanceStrategy:'round-robin',
  modelFeatureDefaults:{vision:'auto',thinking:'auto'},
  requestLogConfig:{enabled:true,maxEntries:200,includeBodies:false,maxBodyChars:8000,redactSensitiveData:true},
}
let config = JSON.parse(localStorage.getItem('settings-qa-config') || 'null') || { ...defaults }
contextBridge.exposeInMainWorld('electronAPI', {
  app:{ getStartupOptions:async () => ({ gpuCompositing:true }), setStartupOptions:async () => {}, relaunch:async () => {} },
  config:{
    get:async () => config,
    update:async updates => {
      calls.push('update')
      await new Promise(resolve => setTimeout(resolve,80))
      if(fail) throw new Error('QA disk write failed')
      config={...config,...updates}
      localStorage.setItem('settings-qa-config', JSON.stringify(config))
      for(const listener of listeners) listener(config)
      return true
    },
    onConfigChanged:listener => {listeners.add(listener);return () => listeners.delete(listener)},
  },
  proxy:{
    getStatus:async () => ({isRunning:running,port:11434,host:'127.0.0.1'}),
    onStatusChanged:() => () => {},
    stop:async () => {calls.push('stop');running=false;return true},
  },
  managementApi:{
    getConfig:async () => ({enableManagementApi:false,managementApiSecret:''}),
    updateConfig:async updates => ({enableManagementApi:false,managementApiSecret:'',...updates}),
    generateSecret:async () => 'qa-secret',
  },
  store:{clearAll:async () => {calls.push('clear');config={...defaults};localStorage.setItem('settings-qa-config',JSON.stringify(config))}},
})
contextBridge.exposeInMainWorld('settingsQA', {
  failSave:value => {fail=value},
  snapshot:() => ({config,calls,running}),
})
