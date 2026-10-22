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
let holdTests = false
let freeSourceOffline = ''
let freeRefreshes = []
let routingTests = []
let failRoutingTest = false
let cancellations = []
const operations = new Map()
const testDelay = signal => new Promise((resolve, reject) => {
  const abort = () => { clearTimeout(timer); reject(new Error('Ollama node scan cancelled')) }
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, holdTests ? 60000 : 250)
  signal.addEventListener('abort', abort, { once: true })
})
const begin = (id, model, total) => {
  const operation = { controller: new AbortController(), providerId:id, model, completed:0, total }
  operations.set(id, operation)
  return operation
}
const testOne = async (id, model, operation) => {
  modelTests.push({id,model})
  await testDelay(operation.controller.signal)
  const node = nodes.find(node => node.id === id)
  const metadata = {...node.ollamaModels[model],endpoint:'ollama_chat',testStatus:failTest ? 'failed' : 'passed',error:failTest ? 'QA selected model failed' : undefined,testedAt:Date.now()}
  updated(id,{ollamaModels:{...node.ollamaModels,[model]:metadata}})
  return metadata
}
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
  status: 'offline', authTypeLabel: 'none', modelCount: 1, disabledModels: [], ollamaModels: {cached:{name:'cached',endpoint:'ollama_chat',vision:'unknown',testStatus:'passed',testedAt:1}},
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
    testRouting: async requestedModel => {
      const routing = {...config.ollamaRouting}
      routingTests = [...routingTests, { requestedModel, routing }]
      await delay(350)
      return { success: !failRoutingTest, requestedModel, routedModel: routing.forceModel ? routing.model : requestedModel,
        providerName: routing.forceModel && routing.model.startsWith('kilo-free/') ? 'Kilo Free' : 'QA node', latency: 350,
        ...(failRoutingTest ? { error: 'QA routing upstream unavailable' } : { response: 'OK' }) }
    },
    routingModels: async refresh => {
      freeRefreshes = [...freeRefreshes, refresh]
      await delay(120)
      if (freeSourceOffline === 'all') throw new Error('QA free catalogue failed')
      return {
        models: [
          { id: 'opencode-free/qa-free', name: 'OpenCode QA' },
          { id: 'kilo-free/qa/free', name: 'Kilo QA' },
          ...Array.from({length:60}, (_,i) => ({id:`kilo-free/qa-${i}/free`,name:`Kilo QA long-model-name-for-scroll-regression-${i}`})),
        ].filter(model => !freeSourceOffline || !model.id.startsWith(freeSourceOffline)),
        sources: ['opencode-free', 'kilo-free'].map(id => ({ id, name: id === 'opencode-free' ? 'OpenCode Free' : 'Kilo Free', stale: id === freeSourceOffline, ...(id === freeSourceOffline ? { error: 'QA source offline' } : {}) })),
      }
    },
    list: async () => { await delay(60); if(failList) {failList=false;throw new Error('QA initial load failed')};return nodes },
    importText: async text => {
      await delay(100)
      if(text.includes('failed')) throw new Error('QA import failed')
      return {imported:0,refreshed:1,invalid:/^https?:\/\//.test(text) ? [] : [text],nodes}
    },
    scan: async id => {
      scans.push(id)
      const node=nodes.find(node=>node.id===id)
      const names=Object.keys(node.ollamaModels)
      const operation=begin(id, '', names.length)
      try {
        await delay(80)
        operation.controller.signal.throwIfAborted()
        if (node.status === 'offline') return node
        updated(id,{ollamaModels:Object.fromEntries(names.map(name=>[name,{name,vision:'unknown',testStatus:'untested'}]))})
        for (const [index, model] of names.entries()) {
          operation.controller.signal.throwIfAborted()
          operation.model=model; operation.completed=index
          await testOne(id, model, operation)
        }
        return nodes.find(node=>node.id===id)
      } catch (error) {
        if(operation.controller.signal.aborted) throw new Error('Ollama node scan cancelled')
        throw error
      } finally { operations.delete(id) }
    },
    getScanProgress: async () => [...operations.values()].map(({providerId,model,completed,total})=>({providerId,model,completed,total})),
    cancelScan: async id => { cancellations.push(id); operations.get(id)?.controller.abort() },
    testModel: async (id, model) => {
      const operation=begin(id, model, 1)
      try { return await testOne(id, model, operation) }
      finally { operations.delete(id) }
    },
    update: async (id, updates) => updated(id,updates),
    updateAuth: async (id, auth) => {authInputs.push(auth);return updated(id,{authTypeLabel:auth.type})},
    setModelEnabled: async (id, model, enabled) => {
      const node=nodes.find(node=>node.id===id)
      return updated(id,{disabledModels:enabled ? node.disabledModels.filter(name=>name!==model) : [...node.disabledModels,model]})
    },
    pinModel: async (model, providerId) => {config={...config,modelMappings:{...config.modelMappings,[model]:{requestModel:model,actualModel:model,preferredProviderId:providerId}}}},
    testVision: async (id,model) => {
      const operation=begin(id, model, 1)
      try { await testDelay(operation.controller.signal); return {...nodes.find(node=>node.id===id).ollamaModels[model],vision:'supported'} }
      finally { operations.delete(id) }
    },
    delete: async id => {nodes=nodes.filter(node=>node.id!==id);return true},
  },
  logs: { get: async filter => {await delay(25);return [{id:'log',providerId:filter.providerId || 'node-a',level:'info',timestamp:Date.now(),message:'Model probe succeeded: qwen3:8b',latency:123}]} },
})
contextBridge.exposeInMainWorld('ollamaQA', {
  failSave: value => {failSave=value},
  failTest: value => {failTest=value},
  holdTests: value => {holdTests=value},
  freeSourceOffline: value => {freeSourceOffline=value},
  failRoutingTest: value => {failRoutingTest=value},
  clearNodes: () => {nodes=[]},
  state: () => ({config,saveCount,authInputs,modelTests,scans,cancellations,freeRefreshes,routingTests,operations:operations.size}),
})
