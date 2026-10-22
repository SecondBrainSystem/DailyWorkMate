import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { startFreeProxy } from '../fixtures/free-proxy.cjs'

const transportFetch = globalThis.fetch
const models = [
  { id: 'kilo-free/test/free', apiModel: 'test/free', name: 'Kilo Test', parameters: ['tools','max_tokens','reasoning'] },
  { id: 'opencode-free/test-free', apiModel: 'test-free', name: 'OpenCode Test', protocol: 'chat-completions', temperature: true },
].map(model => ({ ...model, contextLimit: 10000, outputLimit: 1000, toolCall: true, vision: false, reasoning: true }))
let proxy, calls, mode, refreshes
before(async () => {
  proxy = await startFreeProxy(path.resolve('tmp/qa/free-model-http'))
  for (const [index, catalogue] of [proxy.api.KiloFreeModelCatalogue, proxy.api.OpenCodeFreeModelCatalogue].entries()) {
    test.mock.method(catalogue.prototype, 'get', async refresh => {
      refreshes.push([index, refresh])
      return { models: [models[index]], stale: mode === 'offline-' + index, updatedAt: 1000,
        ...(mode === 'offline-' + index ? { error: 'Catalogue offline' } : {}) }
    })
  }
  test.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.ok(['https://api.kilo.ai/api/gateway/chat/completions','https://opencode.ai/inference/v1/chat/completions'].includes(url))
    const body = JSON.parse(init.body)
    calls.push({ url, body, headers: init.headers, signal: init.signal })
    assert.ok(!JSON.stringify(init.headers).includes(proxy.key), 'Local API key must not reach upstream')
    if (mode === 'limited') return new Response(JSON.stringify({ error: { message: 'Limited' } }), { status: 429, headers: { 'Retry-After': '60' } })
    const frame = data => 'data: ' + JSON.stringify(data) + '\n\n'
    if (mode === 'hold') {
      let closed = false
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(frame({ choices: [{ index: 0, delta: { content: 'first' }, finish_reason: null }] })))
          init.signal.addEventListener('abort', () => { if (!closed) { closed = true; controller.error(new Error('Cancelled upstream')) } }, { once: true })
        },
        cancel() { closed = true },
      }))
    }
    return new Response(frame({ id: 'reply', created: 123, choices: [{ index: 0, delta: { role: 'assistant', content: '回答 OK', reasoning: 'thought' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }) + 'data: [DONE]\n\n')
  })
})
beforeEach(() => {
  calls = []; refreshes = []; mode = 'ok'
  proxy.api.state.config = { ...proxy.api.state.config, ollamaRouting: { forceModel: false, model: '', autoSelectUrl: false, providerId: '' } }
})
after(async () => { await proxy?.close() })
const call = (route, body, headers = {}) => transportFetch(proxy.endpoint + route, {
  method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + proxy.key, 'Content-Type': 'application/json', ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
const request = (model, stream) => ({ model: model.id, messages: [{ role: 'user', content: 'hello' }], stream, max_tokens: 32 })

test('public authentication gates free catalogs and generations before contacting upstream', async () => {
  for (const route of ['/v1/models', '/api/tags', '/v1/chat/completions']) {
    const response = await transportFetch(proxy.endpoint + route)
    assert.equal(response.status, 401); await response.text()
  }
  assert.deepEqual(calls, []); assert.deepEqual(refreshes, [])
})

test('OpenAI and Ollama discovery expose both pools without accounts and preserve namespaced IDs', async () => {
  const listing = await (await call('/v1/models', undefined, { 'X-Refresh-Free-Models': 'true' })).json()
  assert.deepEqual(listing.data.map(model => model.id).sort(), models.map(model => model.id).sort())
  assert.ok(refreshes.every(([, force]) => force === true))
  assert.deepEqual((await (await call('/api/tags')).json()).models.map(model => model.name).sort(), models.map(model => model.id).sort())
  for (const model of models) {
    const detail = await (await call('/v1/models/' + encodeURIComponent(model.id))).json()
    assert.equal(detail.id, model.id)
    const show = await (await call('/api/show', { model: model.id })).json()
    assert.deepEqual(show.capabilities, ['completion','tools','thinking'])
    const verified = await (await call('/v1/models/verify', { model: model.id, recover: true })).json()
    assert.equal(verified.model, model.id); assert.equal(verified.recovered, false)
  }
  assert.equal(calls.length, 0)
})

test('real HTTP OpenAI, Ollama and Anthropic routes forward free models with streaming, usage and attribution', async () => {
  for (const model of models) for (const route of ['/v1/chat/completions','/api/chat','/v1/messages']) for (const stream of [false, true]) {
    const response = await call(route, request(model, stream))
    assert.equal(response.status, 200)
    const text = await response.text()
    assert.match(text, /回答 OK/); assert.match(text, new RegExp(model.id))
    if (stream) assert.match(text, route === '/api/chat' ? /"done":true/ : route === '/v1/messages' ? /message_stop/ : /\[DONE\]/)
    assert.equal(calls.at(-1).body.model, model.apiModel)
    assert.equal(proxy.api.state.stats.at(-1)[0], true)
    assert.equal(proxy.api.state.tokens.at(-1)[1], 7)
    assert.equal(proxy.api.state.requests.at(-1).providerId, model.id.split('/')[0])
    assert.equal(proxy.api.state.requests.at(-1).actualModel, model.apiModel)
    assert.equal(proxy.api.proxyStatusManager.getStatistics().activeConnections, 0)
  }
})

test('routing picker catalogue shares public eligibility and reports each source independently', async () => {
  const catalogue = await proxy.api.listFreeRoutingModels(true)
  assert.deepEqual(catalogue.models.map(m => m.id), models.map(m => m.id))
  assert.ok(refreshes.every(([, refresh]) => refresh === true))
  mode = 'offline-1'
  const partial = await proxy.api.listFreeRoutingModels()
  assert.deepEqual(partial.models.map(m => m.id), [models[0].id])
  assert.equal(partial.sources.find(source => source.id === 'opencode-free').stale, true)
  assert.equal(partial.sources.find(source => source.id === 'kilo-free').stale, false)
})

test('routing tests exercise forced free transports and preserve upstream quota details', async () => {
  for (const model of models) {
    proxy.api.state.config = { ...proxy.api.state.config, ollamaRouting: { forceModel: true, model: model.id, providerId: '', autoSelectUrl: false } }
    const result = await proxy.api.testOllamaRouting('client-alias')
    assert.equal(result.success, true, result.error)
    assert.equal(result.requestedModel, 'client-alias')
    assert.equal(result.routedModel, model.id)
    assert.equal(calls.at(-1).body.model, model.apiModel)
    assert.equal(result.response, '回答 OK')
    mode = 'limited'
    const limited = await proxy.api.testOllamaRouting('client-alias')
    assert.equal(limited.success, false)
    assert.match(limited.error, /Limited/)
    mode = 'ok'
  }
})

test('global free routing replaces client models across HTTP formats with correct response and log attribution', async () => {
  for (const model of models) for (const providerId of ['', 'old-ollama-node']) {
    proxy.api.state.config = { ...proxy.api.state.config, ollamaRouting: { forceModel: true, model: model.id, providerId, autoSelectUrl: false } }
    for (const route of ['/v1/chat/completions', '/api/chat', '/v1/messages', '/v1/completions']) for (const stream of [false, true]) {
      const body = { ...request({ id: 'client-placeholder' }, stream), prompt: 'hello' }
      const response = await call(route, body)
      assert.equal(response.status, 200, route)
      const text = await response.text()
      assert.match(text, /回答 OK/); assert.ok(text.includes(model.id), route)
      assert.equal(calls.at(-1).body.model, model.apiModel)
      const log = proxy.api.state.requests.at(-1)
      assert.equal(log.model, 'client-placeholder'); assert.equal(log.actualModel, model.apiModel)
      assert.equal(log.providerId, model.id.split('/')[0])
      assert.equal(proxy.api.proxyStatusManager.getStatistics().activeConnections, 0)
    }
    // A namespaced client model is also overridden unless explicitly selected in a desktop call.
    const other = models.find(candidate => candidate.id !== model.id)
    assert.equal((await call('/v1/chat/completions', request(other, false))).status, 200)
    assert.equal(calls.at(-1).body.model, model.apiModel)
    assert.equal((await call('/v1/chat/completions', request(other, false), { 'x-dailyworkmate-model-selection': 'explicit' })).status, 200)
    assert.equal(calls.at(-1).body.model, other.apiModel)
  }
})

test('unavailable or rate-limited forced free models fail without falling back to the client model', async () => {
  for (const [index, model] of models.entries()) {
    proxy.api.state.config = { ...proxy.api.state.config, ollamaRouting: { forceModel: true, model: model.id, providerId: '', autoSelectUrl: true } }
    mode = 'offline-' + index
    const before = calls.length
    const offline = await call('/v1/chat/completions', request(models[1 - index], false))
    assert.equal(offline.status, 503); await offline.text()
    assert.equal(calls.length, before)
    mode = 'limited'
    const limited = await call('/v1/chat/completions', request(models[1 - index], false))
    assert.equal(limited.status, 429); await limited.text()
    assert.equal(limited.headers.get('retry-after'), '60')
    assert.equal(calls.length, before + 1); assert.equal(calls.at(-1).body.model, model.apiModel)
  }
})

test('an offline source stays isolated, stale models cannot generate and 429 never swaps models', async () => {
  for (let index = 0; index < models.length; index++) {
    mode = 'offline-' + index
    const list = await (await call('/v1/models')).json()
    assert.deepEqual(list.data.map(m => m.id), [models[1 - index].id])
    const response = await call('/v1/chat/completions', request(models[index], false))
    assert.equal(response.status, 503); await response.text()
    assert.equal((await call('/api/show', { model: models[index].id })).status, 503)
    assert.equal((await call('/v1/models/' + encodeURIComponent(models[index].id))).status, 503)
  }
  assert.equal(calls.length, 0)
  mode = 'limited'
  for (const model of models) {
    const response = await call('/v1/chat/completions', request(model, false))
    assert.equal(response.status, 429); assert.match(await response.text(), /rate limited/)
    assert.equal(response.headers.get('retry-after'), '60')
  }
  assert.equal(calls.length, 2)
})

test('HTTP disconnect cancels either upstream and releases active request counters', async () => {
  mode = 'hold'
  for (const model of models) {
    const controller = new AbortController()
    const response = await transportFetch(proxy.endpoint + '/v1/chat/completions', {
      method: 'POST', headers: { Authorization: 'Bearer ' + proxy.key, 'Content-Type': 'application/json' },
      body: JSON.stringify(request(model, true)), signal: controller.signal,
    })
    const reader = response.body.getReader()
    assert.equal((await reader.read()).done, false)
    controller.abort()
    await reader.cancel().catch(() => {})
    for (let attempt = 0; attempt < 100 && (!calls.at(-1).signal.aborted || proxy.api.proxyStatusManager.getStatistics().activeConnections !== 0); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(calls.at(-1).signal.aborted, true)
    assert.equal(proxy.api.proxyStatusManager.getStatistics().activeConnections, 0)
    assert.equal(proxy.api.state.stats.at(-1)[0], false)
  }
})

test('OpenCode protocols not yet adapted for public chat are hidden and explicitly rejected', async t => {
  const future = { ...models[1], id: 'opencode-free/future', apiModel: 'future', protocol: 'responses' }
  t.mock.method(proxy.api.OpenCodeFreeModelCatalogue.prototype, 'get', async () => ({ models: [models[1], future], stale: false, updatedAt: 1000 }))
  assert.ok(!(await (await call('/v1/models')).json()).data.some(m => m.id === future.id))
  assert.equal((await call('/v1/chat/completions', request(future, false))).status, 400)
  assert.equal(calls.length, 0)
})
