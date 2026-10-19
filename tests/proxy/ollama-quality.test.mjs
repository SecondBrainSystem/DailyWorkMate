import test, { before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import Koa from 'koa'
import bodyParser from 'koa-bodyparser'

const output = path.resolve('tmp/qa/ollama-quality.mjs')
let module, upstream, proxy, endpoint, received
const markerOf = request => request.messages[0].content.match(/VERIFY_[a-f0-9]{32}/)?.[0]
const successful = content => ({ success: true, body: { choices: [{ message: { content } }] } })
before(async () => {
  await mkdir(path.dirname(output), { recursive: true })
  await build({
    stdin: { contents: `export { OllamaQualityVerifier, ollamaQuality } from './src/main/proxy/ollamaQuality.ts'; export { default as models } from './src/main/proxy/routes/models.ts'; export { default as chat } from './src/main/proxy/routes/chat.ts'; export { state } from './src/main/store/store'; export { loadBalancer } from './src/main/proxy/loadbalancer.ts'`, resolveDir: process.cwd() },
    outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external',
    plugins: [{ name: 'isolate-quality-storage', setup(builder) {
      builder.onResolve({ filter: /(?:^electron$|\/store\/store(?:\.ts)?$)/ }, args => ({ path: args.path === 'electron' ? 'electron' : 'store', namespace: 'qa' }))
      builder.onLoad({ filter: /.*/, namespace: 'qa' }, args => ({ contents: args.path === 'electron'
        ? 'export const app = { isPackaged:false }; export const net = {}; export const shell = {}; export class BrowserWindow {}'
        : `import { DEFAULT_CONFIG } from './src/main/store/types.ts';
          export const state = { providers: [], config: {}, outcomes: [], logs: [] };
          export const storeManager = {
            getConfig: () => ({...DEFAULT_CONFIG,...state.config}), getSessionConfig: () => DEFAULT_CONFIG.sessionConfig,
            getProviders: () => state.providers,
            getEffectiveModels: id => state.providers.find(p => p.id === id).supportedModels.map(model => ({displayName:model,actualModelId:model})),
            getAccountsByProviderId: id => [{id,providerId:id,status:'active',credentials:{authType:'none'}}],
            getAccountById: () => undefined,
            addLog: (...args) => state.logs.push(args), recordRequestInStats: (...args) => state.outcomes.push(args), recordAccountUsage: () => {}, updateProvider: () => null,
            recordTokenUsage: () => {}, addRequestLog: () => undefined,
          }`, resolveDir: process.cwd() }))
    } }],
  })
  module = await import(pathToFileURL(output))
  upstream = http.createServer(async (req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    received.push({ url: req.url, body })
    const content = req.url.startsWith('/bad/') ? "There's a simple version of this answer and a more complete one. Here's the simple version."
      : markerOf(body) || body.messages.at(-1).content
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
      res.end(JSON.stringify({ message: { content }, done: true, eval_count: 3 }) + '\n')
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ message: { content }, done: true }))
    }
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const app = new Koa()
  app.use(bodyParser({ jsonLimit: '5mb' }))
  app.use(module.models.routes()); app.use(module.chat.routes())
  proxy = http.createServer(app.callback())
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  endpoint = `http://127.0.0.1:${proxy.address().port}`
})
beforeEach(() => {
  received = []
  module.ollamaQuality.clear()
  module.state.providers = ['bad', 'good'].map(id => ({
    id, name: id, enabled: true, type: 'custom', upstreamKind: 'ollama', createdAt: Date.now(),
    apiEndpoint: `http://127.0.0.1:${upstream.address().port}/${id}/`, headers: {},
    supportedModels: [id === 'bad' ? 'gemma' : 'qwen'],
    ollamaModels: { [id === 'bad' ? 'gemma' : 'qwen']: { endpoint: 'ollama_chat', vision: 'unknown' } },
  }))
  module.state.config = { retryCount: 3, requestTimeout: 2000, loadBalanceStrategy: 'fill-first', modelMappings: {}, ollamaRouting: { forceModel: true, model: 'gemma', autoSelectUrl: true } }
  for (const id of ['bad', 'good']) module.loadBalancer.clearAccountFailure(id)
})
after(async () => {
  for (const server of [proxy, upstream]) { server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve)) }
  await rm(output, { force: true })
})
const post = (route, data) => fetch(endpoint + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-DailyWorkMate-Model-Selection': 'explicit' }, body: JSON.stringify(data) })
const selection = () => module.loadBalancer.selectAccount('qwen', 'fill-first')

test('normal chats bypass marker verification even when its old negative cache exists', async () => {
  const legacy = await module.ollamaQuality.verify(module.loadBalancer.selectAccount('gemma', 'fill-first'), 2000)
  assert.equal(legacy.success, false)
  received = []
  for (const stream of [false, true]) {
    const response = await post('/v1/chat/completions', { model: 'gemma', messages: [{ role: 'user', content: 'PRIVATE_SYNTHETIC_TEXT' }], stream })
    assert.equal(response.status, 200)
    assert.ok((await response.text()).includes("There's a simple version"))
  }
  assert.equal(received.length, 2, 'only the two user requests reach the upstream')
  assert.ok(received.every(item => item.body.messages[0].content === 'PRIVATE_SYNTHETIC_TEXT'))
  assert.equal(module.state.outcomes.at(-1)[0], true)
})

test('routing checks run no inference; long chat content reaches the selected model intact', async () => {
  module.state.providers = module.state.providers.map(provider => provider.id === 'bad' ? {...provider, enabled:false} : provider)
  const verification = await post('/v1/models/verify', { model: 'gemma', recover: true })
  assert.equal(verification.status, 200)
  const result = await verification.json()
  assert.equal(result.model, 'qwen')
  assert.equal(result.previousModel, 'gemma')
  assert.equal(result.recovered, true)
  assert.equal(result.verified, false)
  assert.equal(result.skipped, true)
  assert.equal(received.length, 0)
  const content = '长文本必须完整保留。'.repeat(16000) + 'TAIL_MARKER'
  const response = await post('/v1/chat/completions', { model: result.model, messages: [{ role: 'user', content }], stream: true })
  assert.equal(response.status, 200)
  assert.ok((await response.text()).includes('TAIL_MARKER'))
  const forwarded = received.at(-1).body.messages[0].content
  assert.ok(forwarded === content, `content lengths ${forwarded.length}/${content.length}, prefix ${JSON.stringify(forwarded.slice(0,20))}, url ${received.at(-1).url}`)
  assert.equal(received.length, 1, 'only the actual chat request invokes a model')
  const retry = await post('/v1/models/verify', { model: 'qwen', recover: true })
  assert.equal((await retry.json()).recovered, false)
  assert.equal(received.length, 1)
})

test('unavailable model checks never probe unrelated models or paid providers', async () => {
  module.state.providers = module.state.providers.map(provider => provider.id === 'bad' ? {...provider, enabled:false} : provider)
  const result = await post('/v1/models/verify', { model: 'gemma', recover: false })
  assert.equal(result.status, 503)
  await result.text()
  assert.equal(received.length, 0)
  module.state.providers = module.state.providers.map(provider => provider.id === 'good' ? { ...provider, upstreamKind: undefined } : provider)
  const fallback = await post('/v1/models/verify', { model: 'gemma', recover: true })
  assert.equal(fallback.status, 503)
  await fallback.text()
  const paid = await post('/v1/models/verify', { model: 'qwen', recover: true })
  assert.deepEqual(await paid.json(), { model: 'qwen', providerName: 'good', verified: false, skipped: true, recovered: false })
  assert.equal(received.length, 0)
})

test('quality cache expires and changes to endpoint, model or credential identity require a fresh challenge', async () => {
  let calls = 0, now = 1
  const verifier = new module.OllamaQualityVerifier(async request => { calls += 1; return successful(markerOf(request)) }, () => now)
  const original = selection()
  assert.equal((await verifier.verify(original, 2000)).success, true)
  await verifier.verify(original, 2000)
  assert.equal(calls, 1)
  for (const altered of [
    { ...original, actualModel: 'other' },
    { ...original, provider: { ...original.provider, apiEndpoint: 'http://127.0.0.1:4567' } },
    { ...original, account: { ...original.account, credentials: { authType: 'bearer', token: 'SYNTHETIC_SECRET' } } },
  ]) await verifier.verify(altered, 2000)
  assert.equal(calls, 4)
  now += 30 * 60_000 + 1
  await verifier.verify(original, 2000)
  assert.equal(calls, 5)
})

test('concurrent verification is shared; cancelling one caller leaves the other intact', async () => {
  let calls = 0, release, upstreamSignal
  const verifier = new module.OllamaQualityVerifier((request, _a, _p, _m, _t, signal) => {
    calls += 1; upstreamSignal = signal
    return new Promise(resolve => { release = () => resolve(successful(markerOf(request))) })
  })
  const controller = new AbortController()
  const first = verifier.verify(selection(), 2000, controller.signal)
  const second = verifier.verify(selection(), 2000)
  controller.abort()
  assert.equal((await first).status, 499)
  assert.equal(upstreamSignal.aborted, false)
  release()
  assert.equal((await second).success, true)
  assert.equal(calls, 1)
})

test('cancelling the final subscriber aborts verification and cannot poison the cache', async () => {
  let signal
  const verifier = new module.OllamaQualityVerifier((_r, _a, _p, _m, _t, upstreamSignal) => {
    signal = upstreamSignal
    return new Promise(resolve => upstreamSignal.addEventListener('abort', () => resolve({ success: false, status: 499 })))
  })
  const controller = new AbortController()
  const pending = verifier.verify(selection(), 2000, controller.signal)
  controller.abort()
  assert.equal((await pending).status, 499)
  assert.equal(signal.aborted, true)
  assert.equal(verifier.peek(selection()), undefined)
})

test('verification respects a five-minute request timeout for slow model loading', async () => {
  let receivedTimeout
  const verifier = new module.OllamaQualityVerifier(async (_request, _account, _provider, _model, timeout) => {
    receivedTimeout = timeout
    return { success: true, status: 200, response: { choices: [{ message: { content: 'OK' } }] } }
  })
  await verifier.verify(selection(), 300000)
  assert.equal(receivedTimeout, 300000)
})
