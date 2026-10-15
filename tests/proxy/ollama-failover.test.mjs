import test, { before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const output = path.resolve('tmp/qa/ollama-failover.mjs')
let module, servers, urls, requests, mode
before(async () => {
  await mkdir(path.dirname(output), { recursive: true })
  await build({
    stdin: { contents: `export { dispatchChatCompletion } from './src/main/proxy/dispatch.ts'; export { state } from './src/main/store/store'; export { loadBalancer } from './src/main/proxy/loadbalancer.ts'; export { proxyStatusManager } from './src/main/proxy/status.ts'`, resolveDir: process.cwd() },
    outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external',
    plugins: [{ name: 'isolate-failover-storage', setup(builder) {
      // This suite isolates transport failover; quality challenges have dedicated HTTP tests.
      builder.onResolve({ filter: /\/ollamaQuality$/ }, () => ({ path: 'quality', namespace: 'quality' }))
      builder.onLoad({ filter: /.*/, namespace: 'quality' }, () => ({ contents: 'export const ollamaQuality = { verify: async () => ({success:true}) }' }))
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
            addLog: (...args) => state.logs.push(args), recordRequestInStats: (...args) => state.outcomes.push(args),
            recordTokenUsage: () => {},
          }`, resolveDir: process.cwd() }))
    } }],
  })
  module = await import(pathToFileURL(output))
  servers = [0, 1].map(index => http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    requests.push({ index, body })
    if (index === 0 && mode === 'hang') return
    if (mode === 'all-fail' || index === 0 && (mode === 'fail' || mode === 'bad-input')) {
      res.writeHead(mode === 'bad-input' ? 400 : 503, {'Content-Type':'application/json'})
      res.end(JSON.stringify({error:mode === 'bad-input' ? 'context too large' : 'node overloaded'}))
      return
    }
    if (body.stream) {
      res.writeHead(200, {'Content-Type':'application/x-ndjson'})
      res.write(JSON.stringify({message:{content:'partial'},done:false}) + '\n')
      res.end() // A broken stream must never trigger replay on the second node.
    } else {
      res.writeHead(200, {'Content-Type':'application/json'})
      res.end(JSON.stringify({message:{content:'completed'},done:true}))
    }
  }))
  await Promise.all(servers.map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))))
  urls = servers.map(server => `http://127.0.0.1:${server.address().port}/`)
})

beforeEach(() => {
  requests = []; mode = 'fail'
  module.state.providers = urls.map((url, index) => ({
    id: String(index), name:'Node ' + index, enabled:true, type:'custom', upstreamKind:'ollama', apiEndpoint:url,
    headers:{}, supportedModels:['model'], ollamaModels:{model:{endpoint:'ollama_chat',vision:'unknown'}},
  }))
  module.state.config = {retryCount:3, loadBalanceStrategy:'fill-first', modelMappings:{}, ollamaRouting:{forceModel:false,autoSelectUrl:false}}
  module.state.outcomes = []; module.state.logs = []
  for (const id of ['0','1']) module.loadBalancer.clearAccountFailure(id)
  module.loadBalancer.resetRoundRobinIndex()
  module.proxyStatusManager.resetStatistics()
})

const dispatch = (text = 'hello', stream = false, signal, headers = {}) => module.dispatchChatCompletion({model:'model',messages:[{role:'user',content:text}],stream}, 'qa', undefined, headers, signal)

test('OpenCode tool rounds reuse the successful node while independent sessions keep balancing', async () => {
  mode = 'ok'
  module.state.config = { ...module.state.config, loadBalanceStrategy:'round-robin' }
  const headers = { 'x-opencode-session-id':'ses_affinity_rounds' }
  assert.equal((await dispatch('first tool round', false, undefined, headers)).selection.provider.id, '0')
  assert.equal((await dispatch('next tool round', false, undefined, headers)).selection.provider.id, '0')
  assert.equal((await dispatch('other conversation', false, undefined, { 'x-opencode-session-id':'ses_affinity_other' })).selection.provider.id, '1')
  assert.equal((await dispatch('ordinary API client')).selection.provider.id, '0')
  assert.equal((await dispatch('ordinary API client')).selection.provider.id, '1')
})

test('OpenCode affinity follows same-model failover and cannot override fixed or revoked nodes', async () => {
  mode = 'ok'
  module.state.config = { ...module.state.config, loadBalanceStrategy:'round-robin' }
  const headers = { 'x-opencode-session-id':'ses_affinity_failover' }
  assert.equal((await dispatch('first', false, undefined, headers)).selection.provider.id, '0')
  mode = 'fail'
  assert.equal((await dispatch('node zero failed', false, undefined, headers)).selection.provider.id, '1')
  mode = 'ok'
  module.loadBalancer.clearAccountFailure('0')
  assert.equal((await dispatch('continue after failover', false, undefined, headers)).selection.provider.id, '1')
  module.state.config = { ...module.state.config, modelMappings:{ model:{actualModel:'model',preferredProviderId:'0'} } }
  assert.equal((await dispatch('user pinned zero', false, undefined, headers)).selection.provider.id, '0')
  module.state.config = { ...module.state.config, modelMappings:{} }
  module.state.providers = module.state.providers.map(provider => provider.id === '0' ? { ...provider, enabled:false } : provider)
  assert.equal((await dispatch('zero disabled', false, undefined, headers)).selection.provider.id, '1')
})

test('all failed retries clear the original session preference before nodes recover', async () => {
  mode = 'ok'
  module.state.config = { ...module.state.config, loadBalanceStrategy:'round-robin' }
  const headers = { 'x-opencode-session-id':'ses_affinity_all_failed' }
  assert.equal((await dispatch('first', false, undefined, headers)).selection.provider.id, '0')
  mode = 'all-fail'
  assert.equal((await dispatch('both nodes fail', false, undefined, headers)).result.success, false)
  for (const id of ['0', '1']) module.loadBalancer.clearAccountFailure(id)
  mode = 'ok'
  assert.equal((await dispatch('recovered nodes resume balancing', false, undefined, headers)).selection.provider.id, '1')
})

test('long UTF-8 input survives node failover intact; subsequent requests skip the failed node', async () => {
  for (const strategy of ['round-robin','fill-first','failover']) {
    requests = []
    module.loadBalancer.clearAccountFailure('0')
    module.loadBalancer.resetRoundRobinIndex()
    module.state.config = {...module.state.config, loadBalanceStrategy:strategy}
    const text = '长文本翻译。'.repeat(20000) + 'END'
    const {result, selection} = await dispatch(text)
    assert.equal(result.success, true)
    assert.equal(selection.provider.id, '1')
    assert.deepEqual(requests.map(r => r.index), [0, 1])
    assert.ok(requests.every(r => r.body.messages[0].content === text))
    assert.equal((await dispatch()).selection.provider.id, '1')
    assert.equal(requests.filter(r => r.index === 0).length, 1)
  }
  assert.equal(module.proxyStatusManager.getStatistics().activeConnections, 0)
})

test('fixed providers, different models and disabled retries never switch nodes', async () => {
  for (const kind of ['pinned','different-model','no-retries']) {
    requests = []; module.loadBalancer.clearAccountFailure('0')
    module.state.config = {...module.state.config, retryCount:kind === 'no-retries' ? 0 : 3,
      modelMappings:kind === 'pinned' ? {model:{actualModel:'model',preferredProviderId:'0'}} : {}}
    module.state.providers = module.state.providers.map(provider => provider.id === '1'
      ? {...provider,supportedModels:[kind === 'different-model' ? 'different' : 'model']} : provider)
    const {result} = await dispatch()
    assert.equal(result.success, false)
    assert.match(result.error, /Node 0.*node overloaded/)
    assert.deepEqual(requests.map(r => r.index), [0])
  }
})

test('bad input is reported directly without retrying or quarantining the node', async () => {
  mode = 'bad-input'
  const {result} = await dispatch()
  assert.equal(result.status, 400)
  assert.match(result.error, /context too large/)
  assert.deepEqual(requests.map(r => r.index), [0])
  assert.equal(module.loadBalancer.selectAccount('model','fill-first').provider.id, '0')
})

test('cancellation and partial stream failures never replay on another node', async () => {
  mode = 'hang'
  const controller = new AbortController()
  const pending = dispatch('cancel', false, controller.signal)
  const timer = setTimeout(() => controller.abort(), 100)
  const cancelled = await pending
  clearTimeout(timer)
  assert.equal(cancelled.result.status, 499)
  assert.deepEqual(requests.map(r => r.index), [0])
  assert.equal(module.loadBalancer.selectAccount('model','fill-first').provider.id, '0')
  mode = 'broken-stream'; requests = []
  const streaming = await dispatch('stream', true)
  let failure
  try { for await (const _ of streaming.result.stream) {} } catch (error) { failure = error }
  assert.ok(failure)
  streaming.finishStream(failure)
  assert.deepEqual(requests.map(r => r.index), [0])
  assert.equal(module.proxyStatusManager.getStatistics().activeConnections, 0)
})

after(async () => {
  for (const server of servers || []) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  await rm(output, {force:true})
})
