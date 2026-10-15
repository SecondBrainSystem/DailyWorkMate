import test, { before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const output = path.resolve('tmp/qa/ollama-manager.mjs')
let module, server, baseUrl
let mode = 'normal'
let calls = []
let held
let modelNames = ['model']
let requestBodies = []
beforeEach(() => { mode = 'normal'; calls = []; requestBodies = []; modelNames = ['model']; held = undefined })
before(async () => {
  await mkdir(path.dirname(output), { recursive: true })
  await build({
    stdin: { contents: `export { OllamaNodeManager, discoverModels, probeEndpoint } from './src/main/ollama/manager.ts'; export { reset, state } from './src/main/store/store'`, resolveDir: process.cwd() },
    outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external',
    plugins: [{ name: 'isolate-manager', setup(builder) {
      builder.onResolve({ filter: /\/store\/(store|providers|accounts)$/ }, () => ({ path:'store', namespace:'qa' }))
      builder.onLoad({ filter: /.*/, namespace: 'qa' }, () => ({ contents: `
        export const state = {};
        export function reset(endpoint) {
          state.provider = {id:'node', name:'Node', enabled:true, upstreamKind:'ollama', apiEndpoint:endpoint, headers:{}, supportedModels:[], ollamaModels:{}};
          state.account = {id:'account',providerId:'node',status:'active',credentials:{authType:'bearer',token:'saved-token'}};
          state.config = {modelMappings:{alias:{requestModel:'alias',actualModel:'model',preferredProviderId:'node'}},ollamaRouting:{forceModel:true,model:'model',providerId:'node'}};
        }
        export const ProviderManager = {
          getById: () => state.provider, getAll: () => state.provider ? [state.provider] : [],
          update: (_id, updates) => {if(!state.provider) throw new Error('Node deleted'); state.provider={...state.provider,...updates};return state.provider},
          delete: () => {state.provider=undefined;state.account=undefined;return true},
        };
        export const AccountManager = {
          getByProviderId: () => state.account ? [state.account] : [],
          update: (_id, updates) => {state.account={...state.account,...updates}},
        };
        export const storeManager = {
          addLog: () => {}, getModelOverrides: () => ({}), getConfig: () => state.config,
          updateConfig: updates => {state.config={...state.config,...updates}},
          getEffectiveModels: () => [{displayName:'model',actualModelId:'model'}],
        };
      ` }))
    } }],
  })
  module = await import(pathToFileURL(output))
  server = createServer(async (req, res) => {
    calls.push(req.url)
    let raw = ''
    for await (const chunk of req) raw += chunk
    if (raw) requestBodies.push({ path: req.url, body: JSON.parse(raw) })
    res.setHeader('Content-Type', 'application/json')
    if (mode === 'hold' && req.url === '/api/tags') { held = res; return }
    if (mode === 'hold-probe' && req.url === '/api/chat') { held = res; return }
    if (mode === 'unauthorized') { res.statusCode=401;res.end('{"error":"not authorized"}');return }
    if (req.url === '/api/tags') { res.end(JSON.stringify({models:mode === 'empty' ? [] : modelNames.map(name => ({name}))}));return }
    if (req.url === '/api/show') { res.end('{}');return }
    if (mode === 'empty-tools' && ['/api/chat','/v1/chat/completions'].includes(req.url)) {
      res.end(JSON.stringify({message:{tool_calls:[]},choices:[{message:{tool_calls:[]}}]}));return
    }
    if (mode === 'reasoning' && req.url === '/v1/chat/completions') {res.end('{"choices":[{"message":{"reasoning_content":"checking"}}]}');return}
    if (req.url === '/api/chat' && mode === 'normal') {res.end('{"message":{"content":"OK"},"done":true}');return}
    if (mode === 'empty-tools' && req.url === '/v1/messages') {res.end('{"content":[]}');return}
    res.statusCode=404;res.end('{"error":"not found"}')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})
after(async () => {server?.closeAllConnections(); if(server) await new Promise(resolve=>server.close(resolve));await rm(output,{force:true})})
async function waitForHeld() {
  for(let i=0;i<100;i++) {if(held) return;await new Promise(resolve=>setTimeout(resolve,5))}
  assert.fail('Scan did not reach discovery')
}

test('discovery accepts empty catalogs and authentication failures stop fallback traffic', async () => {
  mode='empty';calls=[]
  assert.deepEqual(await module.discoverModels(baseUrl,{}),[])
  assert.deepEqual(calls,['/api/tags'])
  mode='unauthorized';calls=[]
  await assert.rejects(module.discoverModels(baseUrl,{}),/Authentication.*401/)
  assert.deepEqual(calls,['/api/tags'])
})

test('endpoint probes reject empty tool arrays and recognize reasoning-only responses', async () => {
  mode='empty-tools'
  assert.equal((await module.probeEndpoint(baseUrl,'model',{})).endpoint,undefined)
  mode='reasoning'
  assert.equal((await module.probeEndpoint(baseUrl,'model',{})).endpoint,'openai_chat')
})

test('rescans preserve manual vision evidence and coalesce concurrent discovery', async () => {
  module.reset(baseUrl);mode='normal';calls=[]
  module.state.provider={...module.state.provider,ollamaModels:{model:{name:'model',vision:'supported',visionSource:'manual-test'}}}
  const [a,b]=await Promise.all([module.OllamaNodeManager.scan('node'),module.OllamaNodeManager.scan('node')])
  assert.deepEqual(a,b)
  assert.equal(calls.filter(url=>url==='/api/tags').length,1)
  assert.equal(a.ollamaModels.model.vision,'supported')
  assert.equal(a.ollamaModels.model.visionSource,'manual-test')
})

test('credential edits cancel older scans without clearing saved secrets or overwriting account status', async () => {
  module.reset(baseUrl);mode='hold';held=undefined
  const scan=module.OllamaNodeManager.scan('node')
  const rejected=assert.rejects(scan,/cancelled/)
  await waitForHeld()
  module.OllamaNodeManager.updateAuth('node',{type:'bearer'})
  await rejected
  assert.equal(module.state.account.credentials.token,'saved-token')
  assert.equal(module.state.account.status,'active')
})

test('deleting an in-flight node cannot resurrect it or silently remove strict routing pins', async () => {
  module.reset(baseUrl);mode='hold';held=undefined
  const scan=module.OllamaNodeManager.scan('node')
  const rejected=assert.rejects(scan,/cancelled/)
  await waitForHeld()
  assert.equal(module.OllamaNodeManager.delete('node'),true)
  await rejected
  assert.equal(module.state.provider,undefined)
  assert.equal(module.state.account,undefined)
  assert.equal(module.state.config.ollamaRouting.providerId,'node')
  assert.equal(module.state.config.modelMappings.alias.preferredProviderId,'node')
})

test('unpinning preserves custom aliases and node updates cannot change unrelated provider fields', () => {
  module.reset(baseUrl)
  module.OllamaNodeManager.pinModel('alias')
  assert.deepEqual(module.state.config.modelMappings.alias,{requestModel:'alias',actualModel:'model'})
  module.OllamaNodeManager.update('node',{enabled:false,apiEndpoint:'https://unexpected.example'})
  assert.equal(module.state.provider.apiEndpoint,baseUrl)
})

test('manual scan cancellation releases the scan and preserves provider and account state', async () => {
  module.reset(baseUrl); mode='hold'; held=undefined
  const provider=module.state.provider, account=module.state.account
  const scan=module.OllamaNodeManager.scan('node')
  const rejected=assert.rejects(scan,/cancelled/)
  await waitForHeld()
  const progress=module.OllamaNodeManager.getScanProgress()
  assert.equal(progress[0].providerId,'node')
  progress[0].model='changed-by-client'
  assert.equal(module.OllamaNodeManager.getScanProgress()[0].model,'')
  module.OllamaNodeManager.cancelScan('node')
  await rejected
  assert.equal(module.state.provider,provider)
  assert.equal(module.state.account,account)
  assert.deepEqual(module.OllamaNodeManager.getScanProgress(),[])
})

test('manual test progress names only the clicked model and is cleared after completion', async () => {
  module.reset(baseUrl)
  await module.OllamaNodeManager.scan('node')
  mode='hold-probe'; held=undefined
  const scan=module.OllamaNodeManager.testModel('node', 'model')
  await waitForHeld()
  assert.deepEqual(module.OllamaNodeManager.getScanProgress(),[{providerId:'node',model:'model',completed:0,total:1}])
  held.end('{"message":{"content":"OK"},"done":true}')
  assert.equal((await scan).testStatus,'passed')
  assert.deepEqual(module.OllamaNodeManager.getScanProgress(),[])
})

test('catalog refresh does not test any models or mark untested models failed', async () => {
  module.reset(baseUrl); modelNames = ['model', 'other']
  const summary = await module.OllamaNodeManager.scan('node')
  assert.deepEqual(calls, ['/api/tags'])
  assert.equal(summary.status, 'online')
  assert.deepEqual(summary.supportedModels, modelNames)
  assert.ok(Object.values(summary.ollamaModels).every(model => model.testStatus === 'untested' && !model.error && !model.testedAt))
  assert.ok(Object.values(summary.ollamaModels).every(model => model.endpoint === 'ollama_chat'))
})

test('manual success and failure update only the clicked model and never isolate its account', async () => {
  module.reset(baseUrl); modelNames = ['model', 'other']
  await module.OllamaNodeManager.scan('node')
  const other = module.state.provider.ollamaModels.other, account = module.state.account
  calls = []; requestBodies = []
  const passed = await module.OllamaNodeManager.testModel('node', 'model')
  assert.equal(passed.testStatus, 'passed')
  assert.ok(requestBodies.every(request => request.body.model === 'model'))
  assert.equal(module.state.provider.ollamaModels.other, other)
  assert.equal(module.state.account, account)
  mode = 'empty-tools'; requestBodies = []
  const failed = await module.OllamaNodeManager.testModel('node', 'model')
  assert.equal(failed.testStatus, 'failed')
  assert.ok(failed.error)
  assert.equal(failed.endpoint, 'ollama_chat', 'test failure remains retryable')
  assert.ok(requestBodies.every(request => request.body.model === 'model'))
  assert.equal(module.state.provider.ollamaModels.other, other)
  assert.equal(module.state.provider.status, 'online')
  assert.equal(module.state.account, account)
  await module.OllamaNodeManager.scan('node')
  assert.equal(module.state.provider.ollamaModels.model.testStatus, 'failed', 'refresh preserves explicit evidence')
})

test('refresh clears legacy bulk errors but preserves explicit test results', async () => {
  module.reset(baseUrl); modelNames = ['model', 'other']
  module.state.provider = {...module.state.provider, ollamaModels: {
    model: {name:'model',vision:'unknown',error:'old bulk timeout',testedAt:1},
    other: {name:'other',endpoint:'openai_chat',vision:'supported',testStatus:'passed',testedAt:2},
  }}
  const summary = await module.OllamaNodeManager.scan('node')
  assert.equal(summary.ollamaModels.model.testStatus, 'untested')
  assert.equal(summary.ollamaModels.model.error, undefined)
  assert.equal(summary.ollamaModels.model.testedAt, undefined)
  assert.equal(summary.ollamaModels.other.testStatus, 'passed')
  assert.equal(summary.ollamaModels.other.endpoint, 'openai_chat')
  assert.equal(summary.ollamaModels.other.testedAt, 2)
  assert.deepEqual(calls, ['/api/tags'])
})

test('cancelling a manual model test preserves all stored results and allows retry', async () => {
  module.reset(baseUrl)
  await module.OllamaNodeManager.scan('node')
  const provider = module.state.provider, account = module.state.account
  mode = 'hold-probe'
  const pending = module.OllamaNodeManager.testModel('node', 'model')
  const rejected = assert.rejects(pending, /cancelled/)
  await waitForHeld()
  await assert.rejects(module.OllamaNodeManager.testModel('node', 'model'), /in progress/)
  module.OllamaNodeManager.cancelScan('node')
  await rejected
  assert.equal(module.state.provider, provider)
  assert.equal(module.state.account, account)
  assert.deepEqual(module.OllamaNodeManager.getScanProgress(), [])
  mode = 'normal'
  assert.equal((await module.OllamaNodeManager.testModel('node', 'model')).testStatus, 'passed')
})
