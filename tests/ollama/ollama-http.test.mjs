import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import Koa from 'koa'
import bodyParser from 'koa-bodyparser'

const output = path.resolve('tmp/qa/ollama-http.mjs')
let upstream, proxy, endpoint, module
let received = []
let closed = []
// Modes that already returned their one empty stream (see 'empty-once' below).
const emptied = new Set()
before(async () => {
  await mkdir(path.dirname(output), { recursive: true })
  await build({
    stdin: { contents: `export { default as chat } from './src/main/proxy/routes/chat.ts'; export { default as ollama } from './src/main/proxy/routes/ollama.ts'; export { default as completions } from './src/main/proxy/routes/completions.ts'; export { setup, state } from './src/main/store/store'; export { proxyStatusManager } from './src/main/proxy/status.ts'; export { OllamaAdapter } from './src/main/proxy/adapters/ollama.ts'; export { testOllamaRouting } from './src/main/ollama/routingTest.ts'`, resolveDir: process.cwd() },
    outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external',
    plugins: [{ name: 'isolate-http-storage', setup(builder) {
      builder.onResolve({ filter: /(?:^electron$|\/store\/store(?:\.ts)?$)/ }, args => ({ path: args.path === 'electron' ? 'electron' : 'store', namespace: 'qa' }))
      builder.onLoad({ filter: /.*/, namespace: 'qa' }, args => ({ contents: args.path === 'electron'
        ? 'export const app = { isPackaged:false }; export const net = {}; export const shell = {}; export class BrowserWindow {}'
        : `import { DEFAULT_CONFIG } from './src/main/store/types.ts';
          export const state = { config: {...DEFAULT_CONFIG,retryCount:0}, logs: [], requests: [], outcomes: [], tokens: [], account: {id: 'account', providerId: 'node', name: 'QA', status: 'active', credentials: {authType:'none'}} };
          export const setup = endpoint => { state.provider = {id:'node', name:'QA', enabled:true, type:'custom', upstreamKind:'ollama', apiEndpoint:endpoint, headers:{}, supportedModels:['model','second-model'], ollamaModels:Object.fromEntries(['model','second-model'].map(name=>[name,{name,endpoint:'ollama_chat',vision:'unknown'}]))} };
          export const storeManager = {
            getConfig: () => state.config, getSessionConfig: () => DEFAULT_CONFIG.sessionConfig,
            getProviders: () => [state.provider], getEffectiveModels: () => state.provider.supportedModels.map(id=>({displayName:id,actualModelId:id})),
            getAccountsByProviderId: () => [state.account], getAccountById: () => state.account,
            updateAccount: (_id, updates) => {state.account = {...state.account,...updates}},
            addLog: (...args) => state.logs.push(args), recordRequestInStats: (...args) => state.outcomes.push(args),
            recordAccountUsage: (_id, options = {}) => {state.account = {...state.account, requestCount: (state.account.requestCount || 0) + 1, ...(options.reactivate ? {status:'active', errorMessage:undefined} : {})}},
            updateProvider: (_id, updates) => {state.provider = {...state.provider, ...updates}; return state.provider},
            recordTokenUsage: (...args) => state.tokens.push(args),
            addRequestLog: log => {const entry = {...log,id:String(state.requests.length)};state.requests.push(entry);return entry},
            updateRequestLog: (id, update) => {state.requests = state.requests.map(log => log.id === id ? {...log,...update} : log)},
          }`, resolveDir: process.cwd() }))
    } }],
  })
  module = await import(pathToFileURL(output))
  upstream = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    const mode = body.messages?.[0]?.content || 'ok'
    const verification = mode.match(/VERIFY_[a-f0-9]{32}/)?.[0]
    if (verification) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({message:{content:verification},done:true})); return }
    received.push({ body, headers: req.headers })
    res.once('close', () => closed.push(mode))
    if (req.url === '/v1/chat/completions' && !body.stream) {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ model: body.model, choices: [{ message: { role: 'assistant', content: 'answer' }, finish_reason: 'stop' }] }))
      return
    }
    if (mode === 'hang') return
    if (mode === 'body-error') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: 'model failed to load' })); return }
    if (!body.stream) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({message:{content:'answer'},done:true,eval_count:3})); return }
    res.setHeader('Content-Type', 'application/x-ndjson')
    // A complete HTTP 200 response with no events at all: what the user's remote node returned
    // intermittently. 'empty-once' recovers on the next request; 'empty-always' never does.
    if (mode.startsWith('empty-always') || (mode.startsWith('empty-once') && !emptied.has(mode))) {
      emptied.add(mode)
      res.flushHeaders()
      res.end()
      return
    }
    const frame = value => res.write(JSON.stringify(value) + '\n')
    if (mode === 'error-frame') { frame({error:'generation failed'}); res.end(); return }
    frame({message:{content:'你好'},done:false})
    if (mode === 'truncate') { res.end(); return }
    if (mode === 'pause') return
    if (mode === 'parallel') {
      for (const city of ['Berlin','Paris']) frame({message:{tool_calls:[{function:{name:'weather',arguments:{city}}}]},done:false})
    }
    frame({message:{content:''},done:true,done_reason:'stop',prompt_eval_count:4,eval_count:3})
    if (mode === 'terminal-open') return
    res.end()
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  module.setup(`http://127.0.0.1:${upstream.address().port}/`)
  const app = new Koa()
  app.use(bodyParser())
  for (const router of [module.chat, module.ollama, module.completions]) app.use(router.routes())
  proxy = createServer(app.callback())
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  endpoint = `http://127.0.0.1:${proxy.address().port}`
})
after(async () => {
  for (const server of [proxy, upstream]) { server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve)) }
  await rm(output, { force: true })
})
const post = (route, mode, stream = true, signal) => fetch(endpoint + route, {method:'POST',headers:{'Content-Type':'application/json'},signal,body:JSON.stringify({model:'model',messages:[{role:'user',content:mode}],stream})})

test('fixed and original routing reach the actual upstream and the route test follows the saved policy', async () => {
  const saved = module.state.config
  try {
    for (const autoSelectUrl of [false, true]) for (const forceModel of [false, true]) {
      module.state.config = { ...saved, ollamaRouting: { forceModel, routeOriginalModel: !forceModel, model: 'second-model', providerId: 'node', autoSelectUrl } }
      for (const route of ['/v1/chat/completions', '/api/chat', '/v1/completions']) for (const stream of [false, true]) {
        const response = await fetch(endpoint + route, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'model',messages:[{role:'user',content:'routing'}],prompt:'routing',stream})})
        assert.equal(response.status, 200, await response.text())
        assert.equal(received.at(-1).body.model, forceModel ? 'second-model' : 'model')
      }
      const tested = await module.testOllamaRouting(forceModel ? 'arbitrary-client-model' : 'model')
      assert.equal(tested.success, true, tested.error)
      assert.equal(tested.routedModel, forceModel ? 'second-model' : 'model')
      assert.equal(received.at(-1).body.model, tested.routedModel)
      assert.equal(tested.providerName, 'QA')
      assert.equal(tested.response, 'answer')
    }
    module.state.config = { ...saved, ollamaRouting: { forceModel: false, routeOriginalModel: true, model: 'second-model', providerId: 'node', autoSelectUrl: true } }
    const before = received.length
    const missing = await module.testOllamaRouting('not-installed')
    assert.equal(missing.success, false)
    assert.match(missing.error, /No available/)
    assert.equal(received.length, before, 'No substitution for an unavailable original model')
    for (const value of [null, {}, '', ' ', 'x'.repeat(513)]) await assert.rejects(module.testOllamaRouting(value), /request model/)
  } finally { module.state.config = saved }
})
async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('Timed out waiting for HTTP lifecycle')
}

test('OpenAI and native Ollama routes preserve tool calls, UTF-8 and usage', async () => {
  for (const route of ['/v1/chat/completions','/api/chat']) {
    const response = await post(route, 'parallel')
    assert.equal(response.status, 200)
    const body = await response.text()
    assert.match(body, /你好/)
    assert.match(body, /Berlin/)
    assert.match(body, /Paris/)
    assert.equal(module.state.outcomes.at(-1)[0], true)
    assert.equal(module.state.tokens.at(-1)[1], 7)
  }
})

test('OpenAI upstream forwarding strips internal transport fields and preserves client extensions and tool history', async () => {
  const previous = module.state.provider
  module.state.provider = {
    ...previous,
    ollamaModels: { model: { ...previous.ollamaModels.model, endpoint: 'openai_chat' } },
  }
  const request = {
    model: 'model', stream: false, max_completion_tokens: 32000,
    parallel_tool_calls: false, store: false,
    custom_provider_hint: { mode: 'preserve-this-extension' },
    messages: [
      { role: 'user', content: 'openai-internal-metadata' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_read_fixture', type: 'function', function: { name: 'read', arguments: '{"path":"fixture.txt"}' } }] },
      { role: 'tool', tool_call_id: 'call_read_fixture', content: 'fixture contents' },
    ],
    tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }],
  }
  try {
    const response = await fetch(endpoint + '/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
    })
    assert.equal(response.status, 200)
    await response.json()
    const forwarded = received.at(-1).body
    assert.equal(Object.hasOwn(forwarded, '_signal'), false)
    assert.equal(Object.hasOwn(forwarded, '_timeout'), false)
    assert.deepEqual(forwarded, request)
  } finally {
    module.state.provider = previous
  }
})

test('HTTP 200 error bodies become 502 and interrupted streams are recorded as failures', async () => {
  assert.equal((await post('/v1/chat/completions', 'body-error', false)).status, 502)
  for (const route of ['/v1/chat/completions','/api/chat']) {
    for (const mode of ['truncate','error-frame']) {
      const response = await post(route, mode)
      const body = await response.text()
      assert.match(body, /"error"/)
      assert.doesNotMatch(body, /\[Error:/)
      assert.equal(module.state.outcomes.at(-1)[0], false)
    }
  }
  assert.equal(module.state.requests.at(-1).status, 'error')
})

test('clients can cancel both before headers and during generation without leaking active requests', async () => {
  for (const mode of ['hang','pause']) {
    const before = module.state.outcomes.length
    const controller = new AbortController()
    const pending = post('/v1/chat/completions', mode, true, controller.signal).then(response => response.text()).catch(() => '')
    await waitUntil(() => received.some(item => item.body.messages[0].content === mode))
    assert.equal(module.proxyStatusManager.getStatistics().activeConnections, 1)
    controller.abort()
    await pending
    await waitUntil(() => closed.includes(mode) && module.state.outcomes.length > before)
    assert.equal(module.proxyStatusManager.getStatistics().activeConnections, 0)
    assert.equal(module.state.outcomes.at(-1)[0], false)
  }
})

test('timeouts have 504 status and legacy completions reject batches without issuing a request', async () => {
  const result = await module.OllamaAdapter.forward({model:'model',messages:[{role:'user',content:'hang'}]}, module.state.account, module.state.provider, 'model', 40)
  assert.equal(result.status, 504)
  const before = received.length
  const response = await fetch(endpoint + '/v1/completions', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'model',prompt:['first','second']})})
  assert.equal(response.status, 400)
  assert.equal(received.length, before)
})

test('terminal events finish the response and close an upstream that leaves HTTP open', async () => {
  const response = await post('/api/chat', 'terminal-open', true, AbortSignal.timeout(2000))
  const body = await response.text()
  assert.match(body, /"done":true/)
  await waitUntil(() => closed.includes('terminal-open'))
  assert.equal(module.state.outcomes.at(-1)[0], true)
})

test('consecutive streaming chats each finish with their done event', async () => {
  for (let turn = 0; turn < 4; turn++) {
    for (const route of ['/v1/chat/completions', '/api/chat']) {
      const response = await post(route, `turn-${turn}`)
      assert.equal(response.status, 200)
      const body = await response.text()
      assert.match(body, /你好/)
      assert.doesNotMatch(body, /"error"/)
      assert.equal(module.state.outcomes.at(-1)[0], true)
    }
  }
})

test('a stream that ends before any output is retried once instead of reaching the client as a broken reply', async () => {
  for (const route of ['/v1/chat/completions', '/api/chat']) {
    const mode = `empty-once ${route}`
    const response = await post(route, mode)
    assert.equal(response.status, 200)
    const body = await response.text()
    assert.match(body, /你好/)
    assert.doesNotMatch(body, /"error"/)
    assert.equal(received.filter(item => item.body.messages[0].content === mode).length, 2)
    assert.equal(module.state.outcomes.at(-1)[0], true)
  }
})

test('a node that keeps ending streams before any output fails the request with context', async () => {
  const mode = 'empty-always'
  const response = await post('/v1/chat/completions', mode)
  assert.equal(response.status, 502)
  const { error } = await response.json()
  assert.match(error.message, /ended before its done event/)
  assert.match(error.message, /no output/)
  assert.equal(received.filter(item => item.body.messages[0].content === mode).length, 2)
  assert.equal(module.state.outcomes.at(-1)[0], false)
})
