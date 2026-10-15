const { contextBridge } = require('electron')
localStorage.setItem('i18nextLng', 'en-US')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
let failList = true
let failSave = false
let saveCount = 0
let authInputs = []
let modelTests = []
let scans = []
let failTest = false
let config = {
  proxyHost: '127.0.0.1', proxyPort: 11434, apiKeys: [], enableApiKey: false,
  theme: 'light', language: 'en-US', loadBalanceStrategy: 'round-robin',
  modelMappings: { 'disabled-model': { requestModel: 'disabled-model', actualModel: 'disabled-model', preferredProviderId: 'node-a' } },
  ollamaRouting: { forceModel: false, model: 'qwen3:8b', autoSelectUrl: false, providerId: 'node-a' },
  modelFeatureDefaults: { vision: 'auto', thinking: 'auto' },
}
const longModel = 'organization/model-with-a-very-long-name-and-context-window-128k:quantized-q4_k_m'
let nodes = [{
  id: 'node-a', name: 'Primary Ollama · Research workstation', apiEndpoint: 'http://127.0.0.1:11435', enabled: true,
  status: 'online', authTypeLabel: 'bearer', modelCount: 3, disabledModels: ['disabled-model'],
  ollamaModels: Object.fromEntries(['qwen3:8b', 'disabled-model', longModel].map(name => [name, {name,endpoint:'ollama_chat',vision:name === 'disabled-model' ? 'unsupported' : 'unknown',error:name === 'disabled-model' ? 'Old bulk timeout' : undefined}])),
}, {
  id: 'node-b', name: 'Unreachable remote node with a long descriptive name', apiEndpoint: 'https://example.invalid/team/research/ollama', enabled: false,
  status: 'offline', authTypeLabel: 'none', modelCount: 0, disabledModels: [], ollamaModels: {},
  lastScanError: 'Connection refused. Check the node address and rescan after the server is available.',
}]
const updated = (id, updates) => { nodes = nodes.map(node => node.id === id ? {...node,...updates} : node); return nodes.find(node => node.id === id) }
contextBridge.exposeInMainWorld('electronAPI', {
  config: { get: async () => config, update: async updates => {
    saveCount++; await delay(300); if(failSave) throw new Error('QA save failed')
    config={...config,...updates};return true
  }, onConfigChanged: () => () => {} },
  store: { get: async key => key === 'config' ? config : [], set: async () => {} },
  proxy: { getStatus: async () => ({isRunning:true,port:11434,host:'127.0.0.1'}), onStatusChanged: () => () => {} },
  statistics: { get: async () => ({dailyStats:{},accountUsage:{}}) },
  ollama: {
    list: async () => { await delay(60); if(failList) {failList=false;throw new Error('QA initial load failed')};return nodes },
    importText: async text => {
      await delay(100)
      if(text.includes('failed')) throw new Error('QA import failed')
      return {imported:0,refreshed:1,invalid:/^https?:\/\//.test(text) ? [] : [text],nodes}
    },
    scan: async id => {scans.push(id);await delay(80);return nodes.find(node=>node.id===id)},
    getScanProgress: async () => [],
    cancelScan: async () => {},
    testModel: async (id, model) => {
      modelTests.push({id,model});await delay(250)
      const node=nodes.find(node=>node.id===id)
      const metadata={...node.ollamaModels[model],testStatus:failTest ? 'failed' : 'passed',error:failTest ? 'QA selected model failed' : undefined,testedAt:Date.now()}
      updated(id,{ollamaModels:{...node.ollamaModels,[model]:metadata}})
      return metadata
    },
    update: async (id, updates) => updated(id,updates),
    updateAuth: async (id, auth) => {authInputs.push(auth);return updated(id,{authTypeLabel:auth.type})},
    setModelEnabled: async (id, model, enabled) => {
      const node=nodes.find(node=>node.id===id)
      return updated(id,{disabledModels:enabled ? node.disabledModels.filter(name=>name!==model) : [...node.disabledModels,model]})
    },
    pinModel: async (model, providerId) => {config={...config,modelMappings:{...config.modelMappings,[model]:{requestModel:model,actualModel:model,preferredProviderId:providerId}}}},
    testVision: async (_id,model) => ({name:model,endpoint:'ollama_chat',vision:'supported'}),
    delete: async id => {nodes=nodes.filter(node=>node.id!==id);return true},
  },
  logs: { get: async filter => {await delay(25);return [{id:'log',providerId:filter.providerId || 'node-a',level:'info',timestamp:Date.now(),message:'Model probe succeeded: qwen3:8b',latency:123}]} },
})
contextBridge.exposeInMainWorld('ollamaQA', {
  failSave: value => {failSave=value},
  failTest: value => {failTest=value},
  state: () => ({config,saveCount,authInputs,modelTests,scans}),
})
