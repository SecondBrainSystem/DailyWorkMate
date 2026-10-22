// Real inference service, dispatch, load balancer and provider adapters. Only persistent storage is isolated.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, Server } from 'node:http'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const output = path.resolve('tmp/qa/internal-direct-dispatch-test.mjs')
const originalListen = Server.prototype.listen
const listenAttempts = []
const received = []
let module, upstream
before(async () => {
  await mkdir(path.dirname(output), { recursive: true })
  await build({
    stdin: { contents: `export { executeInternalInference } from './src/main/inference/service.ts'; export { kiloFreeModels } from './src/main/inference/kiloModels.ts'; export { proxyStatusManager } from './src/main/proxy/status.ts'; export { setup, state } from './src/main/store/store'`, resolveDir: process.cwd() },
    outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external',
    plugins: [{ name: 'isolate-storage-only', setup(builder) {
      builder.onResolve({ filter: /(?:^electron$|\/store\/store(?:\.ts)?$)/ }, args => ({ path: args.path === 'electron' ? 'electron' : 'store', namespace: 'qa' }))
      builder.onLoad({ filter: /.*/, namespace: 'qa' }, args => ({ resolveDir: process.cwd(), contents: args.path === 'electron'
        ? `export const app = {isPackaged:false}; export const net = {}; export const shell = {}; export class BrowserWindow {}`
        : `import { DEFAULT_CONFIG } from './src/main/store/types.ts';
          export const state = {logs:[], requests:[], tokens:[], stats:[], providers:[], accounts:[]};
          export const setup = base => {
            const entry = (id,protocol,model,key) => ({provider:{id,name:id,type:'custom',authType:'token',apiEndpoint:base+(protocol==='anthropic'?'':'/v1'),chatPath:protocol==='anthropic'?'/v1/messages':'/chat/completions',headers:{},enabled:true,supportedModels:[model],modelMappings:{[model]:model},upstreamKind:'api',apiPreset:protocol,apiProtocol:protocol,createdAt:0,updatedAt:0},account:{id:id+'-account',providerId:id,name:id,status:'active',credentials:{apiKey:key}}});
            const entries=[entry('official-openai','openai','gpt-direct-test','test-openai-key'),entry('official-anthropic','anthropic','claude-direct-test','test-anthropic-key')];
            state.providers=entries.map(value=>value.provider); state.accounts=entries.map(value=>value.account);
          };
          export const storeManager = {
            getConfig:()=>({...DEFAULT_CONFIG,proxyPort:11434,proxyHost:'127.0.0.1',retryCount:0,autoStartProxy:false,ollamaRouting:{...DEFAULT_CONFIG.ollamaRouting,forceModel:true,model:'public-only-model',providerId:'unavailable-public-node',autoSelectUrl:false}}),getSessionConfig:()=>DEFAULT_CONFIG.sessionConfig,
            getProviders:()=>state.providers,getProviderById:id=>state.providers.find(value=>value.id===id),getEffectiveModels:id=>(state.providers.find(value=>value.id===id)?.supportedModels||[]).map(model=>({displayName:model,actualModelId:model})),
            getAccountsByProviderId:id=>state.accounts.filter(value=>value.providerId===id),getAccountById:id=>state.accounts.find(value=>value.id===id),updateAccount:(id,updates)=>{state.accounts=state.accounts.map(value=>value.id===id?{...value,...updates}:value)},
            addLog:(...args)=>state.logs.push(args),recordRequestInStats:(...args)=>state.stats.push(args),recordAccountUsage:id=>{state.accounts=state.accounts.map(value=>value.id===id?{...value,requestCount:(value.requestCount||0)+1,lastUsed:Date.now()}:value)},updateProvider:()=>null,recordTokenUsage:(...args)=>state.tokens.push(args),
            addRequestLog:log=>{const entry={...log,id:String(state.requests.length)};state.requests.push(entry);return entry},updateRequestLog:(id,updates)=>{state.requests=state.requests.map(value=>value.id===id?{...value,...updates}:value)},
          };` }))
    } }],
  })
  upstream = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    received.push({ path:req.url, headers:req.headers, body })
    if (req.url === '/v1/messages') {
      res.writeHead(200, {'content-type':'application/json'})
      res.end(JSON.stringify({id:'anthropic-result',type:'message',role:'assistant',model:body.model,content:[{type:'text',text:'Anthropic direct answer'}],stop_reason:'end_turn',usage:{input_tokens:7,output_tokens:3}}))
      return
    }
    if (body.stream) {
      res.writeHead(200, {'content-type':'text/event-stream'})
      res.write(`data: ${JSON.stringify({id:'stream-result',object:'chat.completion.chunk',model:body.model,choices:[{index:0,delta:{content:'中文 direct stream'},finish_reason:null}]})}\n\n`)
      res.write(`data: ${JSON.stringify({id:'stream-result',object:'chat.completion.chunk',model:body.model,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:8,completion_tokens:9,total_tokens:17}})}\n\n`)
      res.end('data: [DONE]\n\n')
      return
    }
    res.writeHead(200, {'content-type':'application/json'})
    res.end(JSON.stringify({id:'direct-result',object:'chat.completion',model:body.model,choices:[{index:0,message:{role:'assistant',content:'OpenAI direct answer'},finish_reason:'stop'}],usage:{prompt_tokens:6,completion_tokens:5,total_tokens:11}}))
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  // Any attempt by desktop inference to start a public or compatibility listener fails like the user's EACCES.
  Server.prototype.listen = function (...args) {
    listenAttempts.push(args[0])
    throw Object.assign(new Error('listen EACCES: permission denied 127.0.0.1:11434'), {code:'EACCES'})
  }
  module = await import(pathToFileURL(output))
  module.setup(`http://127.0.0.1:${upstream.address().port}`)
})
after(async () => {
  Server.prototype.listen = originalListen
  upstream?.closeAllConnections()
  if (upstream) await new Promise(resolve => upstream.close(resolve))
  await rm(output, {force:true})
})

const request = (model, stream = false) => module.executeInternalInference({id:'real-request',path:'/v1/chat/completions',headers:{'x-dailyworkmate-model-selection':'explicit'},body:{model,stream,messages:[{role:'user',content:'hello'}]}},new AbortController().signal)

test('non-stream desktop completion reaches the real OpenAI adapter while every local listen is denied', async () => {
  const result = await request('gpt-direct-test')
  assert.equal(result.response.status, 200)
  assert.equal(result.response.body.choices[0].message.content, 'OpenAI direct answer')
  assert.equal(received.at(-1).path, '/v1/chat/completions')
  assert.equal(received.at(-1).headers.authorization, 'Bearer test-openai-key')
  assert.equal(module.state.requests.at(-1).providerId, 'official-openai')
  assert.equal(module.state.requests.at(-1).status, 'success')
  assert.deepEqual(module.state.tokens.at(-1), ['gpt-direct-test',11])
  assert.equal(module.proxyStatusManager.getRunningStatus().isRunning, false)
  assert.deepEqual(listenAttempts, [])
})

test('stream desktop completion traverses real dispatch and forwarding without a public proxy or internal bridge', async () => {
  const result = await request('gpt-direct-test', true)
  assert.equal(result.response.stream, true)
  let content = ''; for await (const chunk of result.output) content += chunk.toString()
  assert.match(content, /中文 direct stream/)
  assert.match(content, /\[DONE\]/)
  assert.equal(received.at(-1).body.stream, true)
  assert.equal(module.state.requests.at(-1).status, 'success')
  assert.match(module.state.requests.at(-1).responseBody, /direct stream/)
  assert.deepEqual(module.state.tokens.at(-1), ['gpt-direct-test',17])
  assert.equal(module.proxyStatusManager.getStatistics().activeConnections, 0)
  assert.deepEqual(listenAttempts, [])
})

test('desktop inference keeps official Anthropic protocol conversion and credentials in the main process', async () => {
  const result = await request('claude-direct-test')
  assert.equal(result.response.status, 200)
  assert.equal(result.response.body.choices[0].message.content, 'Anthropic direct answer')
  assert.equal(received.at(-1).path, '/v1/messages')
  assert.equal(received.at(-1).headers['x-api-key'], 'test-anthropic-key')
  assert.equal(received.at(-1).headers.authorization, undefined)
  assert.doesNotMatch(JSON.stringify(result.response), /test-anthropic-key/)
  assert.deepEqual(module.state.tokens.at(-1), ['claude-direct-test',10])
  assert.deepEqual(listenAttempts, [])
})

test('public fixed-model routing cannot override desktop selection even when the renderer omits or changes its routing header', async () => {
  for (const headers of [undefined, {'x-dailyworkmate-model-selection':'automatic'}]) {
    const result = await module.executeInternalInference({id:'explicit-main-boundary',path:'/v1/chat/completions',headers,body:{model:'gpt-direct-test',messages:[{role:'user',content:'hello'}]}},new AbortController().signal)
    assert.equal(result.response.status, 200)
    assert.equal(received.at(-1).body.model, 'gpt-direct-test')
    assert.equal(result.response.body.model, 'gpt-direct-test')
    assert.equal(module.state.requests.at(-1).providerId, 'official-openai')
  }
  assert.deepEqual(listenAttempts, [])
})

test('desktop free models are listed and verified without accounts; forced refresh and outages preserve configured models', async t => {
  const model = { id: 'kilo-free/test/free', apiModel: 'test/free', name: 'Kilo QA' }
  let force
  t.mock.method(module.kiloFreeModels, 'get', async refresh => { force = refresh; return { models: [model], stale: false, updatedAt: 1000 } })
  t.mock.method(module.kiloFreeModels, 'resolve', async id => { assert.equal(id, model.id); return model })
  const listing = await module.executeInternalInference({ id: 'kilo-list', path: '/v1/models', headers: { 'x-refresh-free-models': 'true' } }, new AbortController().signal)
  assert.equal(force, true)
  assert.ok(listing.response.body.data.some(item => item.id === 'gpt-direct-test'))
  assert.equal(listing.response.body.data.find(item => item.id === model.id).owned_by, 'Kilo Free')
  const checked = await module.executeInternalInference({ id: 'kilo-verify', path: '/v1/models/verify', body: { model: model.id } }, new AbortController().signal)
  assert.equal(checked.response.body.model, model.id)
  assert.equal(checked.response.body.skipped, true)
  assert.equal(checked.response.body.recovered, false)
  t.mock.method(module.kiloFreeModels, 'get', async () => ({ models: [model], stale: true, updatedAt: 1000, error: 'QA Kilo outage' }))
  const offline = await module.executeInternalInference({ id: 'kilo-offline', path: '/v1/models' }, new AbortController().signal)
  assert.ok(offline.response.body.data.some(item => item.id === 'gpt-direct-test'))
  assert.ok(!offline.response.body.data.some(item => item.id === model.id))
  assert.equal(offline.response.body.kilo.error, 'QA Kilo outage')
})

test('Kilo desktop requests use real dispatch and logs while ignoring public fixed-model defaults', async t => {
  const model = { id: 'kilo-free/test/free', apiModel: 'test/free', name: 'Kilo QA', contextLimit: 100000, outputLimit: 1000,
    toolCall: true, vision: false, reasoning: true, parameters: ['tools', 'max_tokens', 'reasoning'] }
  t.mock.method(module.kiloFreeModels, 'resolve', async id => { assert.equal(id, model.id); return model })
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://api.kilo.ai/api/gateway/chat/completions')
    assert.equal(init.headers.Authorization, undefined)
    assert.equal(JSON.parse(init.body).model, model.apiModel)
    return new Response('data: ' + JSON.stringify({ id: 'kilo-test', choices: [{ index: 0, delta: { content: 'Kilo desktop answer' }, finish_reason: 'stop' }], usage: { total_tokens: 8 } }) + '\n\ndata: [DONE]\n\n')
  })
  for (const stream of [false, true]) {
    const result = await request(model.id, stream)
    assert.equal(result.response.status, 200)
    if (stream) { let body = ''; for await (const chunk of result.output) body += chunk; assert.match(body, /Kilo desktop answer/); assert.match(body, /\[DONE\]/) }
    else assert.equal(result.response.body.choices[0].message.content, 'Kilo desktop answer')
    assert.equal(module.state.requests.at(-1).providerId, 'kilo-free')
    assert.equal(module.state.requests.at(-1).model, model.id)
    assert.equal(module.state.requests.at(-1).actualModel, model.apiModel)
    assert.deepEqual(module.state.tokens.at(-1), [model.id, 8])
    assert.equal(module.state.stats.at(-1)[3], 'kilo-free')
    assert.equal(module.proxyStatusManager.getStatistics().activeConnections, 0)
  }
  assert.deepEqual(listenAttempts, [])
})
