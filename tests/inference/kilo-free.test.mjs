import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const output = path.resolve('tmp/qa/kilo-free-test.mjs')
let api
before(async () => {
  await mkdir(path.dirname(output), { recursive: true })
  await build({ stdin: { contents: `export * from './src/main/inference/kiloModels.ts'; export * from './src/main/inference/kiloTransport.ts'`, resolveDir: process.cwd() },
    outfile: output, bundle: true, format: 'esm', platform: 'node', packages: 'external' })
  api = await import(pathToFileURL(output))
})
after(async () => { await rm(output, { force: true }) })

const row = (id = 'vendor/model:free', extra = {}) => ({ id, isFree: true, name: 'Free model', pricing: { prompt: '0', completion: '0' },
  context_length: 100000, top_provider: { max_completion_tokens: 8192 },
  architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
  supported_parameters: ['max_tokens', 'tools', 'tool_choice', 'temperature', 'reasoning'], ...extra })
const request = extra => ({ model: 'kilo-free/vendor/model:free', messages: [{ role: 'user', content: 'hello' }], ...extra })
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })
const encode = value => 'data: ' + JSON.stringify(value) + '\n\n'
const chunk = (delta, extra = {}) => ({ id: 'test', created: 1, model: 'vendor/model:free', choices: [{ index: 0, delta, finish_reason: null }], ...extra })
const deps = (fetcher, model) => ({ fetch: fetcher, resolve: async () => model || api.parseKiloFreeModels({ data: [row()] })[0] })
async function text(output) { let result = ''; for await (const chunk of output) result += chunk.toString(); return result }

test('free catalogue requires explicit isFree and text support, rejects paid pricing and unsafe IDs', () => {
  const candidates = [row(), row(), row('paid-free', { isFree: false }), row('no-flag-free', { isFree: undefined }),
    row('paid', { pricing: { prompt: '0', completion: '0.01' } }), row('bad-price', { pricing: { request: 'NaN' } }),
    row('../paid'), row('vendor//paid'), row('vendor/../../paid'), row('only-image', { architecture: { input_modalities: ['image'], output_modalities: ['image'] } }),
    row('kilo-auto/free')]
  assert.deepEqual(api.parseKiloFreeModels({ data: candidates }).map(model => model.apiModel).sort(), ['kilo-auto/free', 'vendor/model:free'])
  assert.throws(() => api.parseKiloFreeModels({ data: {} }), /catalogue/)
})

test('catalogue coalesces refresh, enforces TTL, blocks stale or removed models and allows recovery', async () => {
  let now = 1000, calls = 0, offline = false, paid = false
  const catalogue = new api.KiloFreeModelCatalogue(async (url, options) => {
    calls++
    assert.equal(url, api.KILO_BASE_URL + '/models')
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers.Authorization, undefined)
    if (offline) throw new Error('offline')
    return json({ data: [row(undefined, { isFree: !paid })] })
  }, () => now)
  const snapshots = await Promise.all([catalogue.get(), catalogue.get(), catalogue.get()])
  assert.equal(calls, 1)
  snapshots[0].models[0].name = 'tampered'
  assert.equal((await catalogue.resolve(request().model)).name, 'Free model')
  now += api.KILO_CATALOGUE_TTL + 1; offline = true
  assert.equal((await catalogue.get()).stale, true)
  await assert.rejects(catalogue.resolve(request().model), error => error.status === 503)
  assert.equal(calls, 2)
  offline = false; paid = true
  await catalogue.get(true)
  await assert.rejects(catalogue.resolve(request().model), error => error.status === 404)
  await assert.rejects(catalogue.resolve('kilo-free/vendor/../paid'), error => error.status === 400)
  paid = false
  assert.equal((await catalogue.get(true)).models.length, 1)
})

test('request boundary preserves explicit reasoning and history, strips arbitrary extras and caps output', () => {
  const model = api.parseKiloFreeModels({ data: [row()] })[0]
  const input = request({ max_tokens: 10000, enable_thinking: false, extra_body: { model: 'paid', apiKey: 'secret', baseURL: 'https://evil.test' },
    messages: [{ role: 'assistant', content: 'old', reasoning_content: '' }, { role: 'user', content: 'next' }] })
  const before = structuredClone(input)
  const body = api.buildKiloRequest(input, model)
  assert.equal(body.model, 'vendor/model:free')
  assert.deepEqual(body.reasoning, { enabled: false })
  assert.equal(body.messages[0].reasoning, '')
  assert.equal(body.max_tokens, 8192)
  assert.equal(body.apiKey, undefined); assert.equal(body.baseURL, undefined)
  assert.deepEqual(input, before)
  assert.deepEqual(api.buildKiloRequest(request({ reasoning_effort: 'high' }), model).reasoning, { effort: 'high' })
  assert.throws(() => api.buildKiloRequest(request({ max_tokens: -1 }), model), /positive/)
  assert.throws(() => api.buildKiloRequest(request({ web_search: true }), model), /search/)
  assert.throws(() => api.buildKiloRequest(request({ tools: [{ type: 'function', function: { name: 'read' } }] }), { ...model, toolCall: false }), /tool/)
  assert.throws(() => api.buildKiloRequest(request({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] }] }), { ...model, vision: false }), /images/)
})

test('stream handles split UTF-8/SSE with misleading JSON content type, reasoning and tools without auth', async () => {
  const sse = ': KILO PROCESSING\r\n\r\n' + encode(chunk({ reasoning: '思考' }))
    + encode(chunk({ content: '你好', tool_calls: [{ index: 0, id: 'call', type: 'function', function: { name: 'read', arguments: '{}' } }] }))
    + encode(chunk({}, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { total_tokens: 9 } })) + 'data: [DONE]\n\n'
  const bytes = new TextEncoder().encode(sse)
  const result = await api.forwardKiloCompletion(request({ stream: true }), undefined, 1000, deps(async (url, init) => {
    assert.equal(url, api.KILO_BASE_URL + '/chat/completions')
    assert.equal(init.headers.Authorization, undefined)
    assert.equal(init.redirect, 'error')
    return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3)); controller.close() } }), { headers: { 'content-type': 'application/json' } })
  }))
  assert.equal(result.skipTransform, true)
  const body = await text(result.stream)
  assert.match(body, /你好/); assert.match(body, /"reasoning_content":"思考"/)
  assert.match(body, /"name":"read"/); assert.match(body, /"model":"kilo-free\/vendor\/model:free"/)
  assert.equal((body.match(/\[DONE\]/g) || []).length, 1)
})

test('non-stream aggregates reasoning, split tool arguments, finish reason and usage', async () => {
  const sse = encode(chunk({ reasoning: 'reason' }))
    + encode(chunk({ tool_calls: [{ index: 0, id: 'call', function: { name: 'read', arguments: '{"path":' } }] }))
    + encode(chunk({ tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] }))
    + encode(chunk({}, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { total_tokens: 12 } })) + 'data: [DONE]\n\n'
  const result = await api.forwardKiloCompletion(request(), undefined, 1000, deps(async () => new Response(sse)))
  assert.equal(result.success, true)
  assert.equal(result.body.choices[0].message.reasoning_content, 'reason')
  assert.equal(result.body.choices[0].message.tool_calls[0].function.arguments, '{"path":"a"}')
  assert.equal(result.body.choices[0].finish_reason, 'tool_calls')
  assert.equal(result.body.usage.total_tokens, 12)
})

test('a complete JSON reply to a stream request becomes a valid SSE completion', async () => {
  const result = await api.forwardKiloCompletion(request({ stream: true }), undefined, 1000, deps(async () => json({
    id: 'json', choices: [{ index: 0, message: { role: 'assistant', content: 'answer', reasoning: 'reason' }, finish_reason: 'stop' }], usage: { total_tokens: 4 },
  })))
  const body = await text(result.stream)
  assert.match(body, /"delta":/); assert.match(body, /answer/); assert.match(body, /reasoning_content/); assert.match(body, /\[DONE\]/)
})

test('rate limits retain retry interval, refusals never retry or substitute another model', async () => {
  let calls = 0
  const result = await api.forwardKiloCompletion(request(), undefined, 1000, deps(async () => {
    calls++; return new Response(JSON.stringify({ error: { message: 'limit' } }), { status: 429, headers: { 'retry-after': '15' } })
  }))
  assert.equal(result.status, 429); assert.equal(result.retryAfterMs, 15000); assert.equal(calls, 1)
  assert.match(result.error, /public IP/)
  assert.match(result.error, /\nlimit$/)
  let fetched = false
  const removed = await api.forwardKiloCompletion(request(), undefined, 1000, { fetch: async () => { fetched = true }, resolve: async () => { throw new api.KiloModelError('no longer free', 404) } })
  assert.equal(removed.status, 404); assert.equal(fetched, false)
})

test('rate limits preserve string errors, redact secrets and accept HTTP-date retry headers', async () => {
  const retryAt = Date.now() + 60_000
  const result = await api.forwardKiloCompletion(request(), undefined, 1000, deps(async () => new Response(
    JSON.stringify({ error: 'Rate limit exceeded for free models; Bearer private-token' }),
    { status: 429, headers: { 'retry-after': new Date(retryAt).toUTCString() } },
  )))
  assert.equal(result.status, 429)
  assert.match(result.error, /Rate limit exceeded for free models/)
  assert.ok(!result.error.includes('private-token'))
  assert.ok(result.retryAfterMs > 55_000 && result.retryAfterMs <= 60_000)
})

test('upstream errors and truncated streams cannot appear as successful complete replies', async () => {
  for (const sse of [encode(chunk({ content: 'partial' })), encode({ error: { message: 'upstream failed' } })]) {
    const result = await api.forwardKiloCompletion(request({ stream: true }), undefined, 1000, deps(async () => new Response(sse)))
    await assert.rejects(text(result.stream), /before completion|upstream failed/)
  }
})

test('usage-only tail packets preserve completion identity, and DONE alone cannot report success', async () => {
  const sse = encode(chunk({ content: 'answer' }, { choices: [{ index: 0, delta: { content: 'answer' }, finish_reason: 'stop' }] }))
    + encode({ choices: [], usage: { total_tokens: 5 } }) + 'data: [DONE]\n\n'
  const result = await api.forwardKiloCompletion(request(), undefined, 1000, deps(async () => new Response(sse)))
  assert.equal(result.body.id, 'test')
  assert.equal(result.body.created, 1)
  const empty = await api.forwardKiloCompletion(request(), undefined, 1000, deps(async () => new Response('data: [DONE]\n\n')))
  assert.equal(empty.success, false)
})

test('cancelling during catalogue lookup returns promptly without posting a completion', async () => {
  const controller = new AbortController()
  let fetched = false, release
  const waiting = new Promise(resolve => { release = resolve })
  const result = api.forwardKiloCompletion(request(), controller.signal, 1000, {
    resolve: async () => { await waiting; return api.parseKiloFreeModels({ data: [row()] })[0] },
    fetch: async () => { fetched = true; return json({}) },
  })
  controller.abort()
  const raced = await Promise.race([result, new Promise(resolve => setTimeout(() => resolve('hung'), 30))])
  release()
  assert.notEqual(raced, 'hung')
  assert.equal(raced.status, 499)
  assert.equal(fetched, false)
})

test('cancellation and idle timeout abort the upstream fetch, with no listener leak', async () => {
  const controller = new AbortController()
  const hanging = async (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }))
  const pending = api.forwardKiloCompletion(request(), controller.signal, 1000, deps(hanging))
  setTimeout(() => controller.abort(), 10)
  assert.equal((await pending).status, 499)
  const keepAlive = setInterval(() => {}, 1000)
  try { assert.equal((await api.forwardKiloCompletion(request(), undefined, 10, deps(hanging))).success, false) }
  finally { clearInterval(keepAlive) }
})
