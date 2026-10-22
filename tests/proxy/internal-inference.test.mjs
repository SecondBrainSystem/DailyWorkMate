import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import path from 'node:path'
import { mkdir, rm } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const output = path.resolve('tmp/qa/internal-inference-test.mjs')
let module
before(async () => {
  await mkdir(path.dirname(output), { recursive: true })
  await build({
    stdin: { contents: `export * from './src/main/inference/service.ts'; export * from './src/main/inference/ipc.ts'; export { state, reset } from 'inference-test-state'; export { ipcMain } from 'electron'; export { kiloFreeModels } from './src/main/inference/kiloModels.ts'`, resolveDir: process.cwd() },
    outfile: output, bundle: true, format: 'esm', platform: 'node', packages: 'external',
    plugins: [{ name: 'isolate-inference', setup(builder) {
      builder.onResolve({ filter: /^(?:electron|inference-test-state)$/ }, args => ({ path: args.path, namespace: 'qa' }))
      builder.onResolve({ filter: /\/(?:store\/store|proxy\/dispatch|proxy\/modelCatalog|proxy\/modelVerification|proxy\/stream)$/ }, args => ({ path: args.path.split('/').at(-1), namespace: 'qa' }))
      builder.onLoad({ filter: /.*/, namespace: 'qa' }, args => ({ contents: {
        'inference-test-state': `export let state; export const reset = () => { state = { calls: [], logs: [], updates: [], tokens: [], finishes: [], transforms: [] } }; reset();`,
        electron: `export const ipcMain = { handlers: new Map(), removeHandler(channel) { this.handlers.delete(channel) }, handle(channel, fn) { this.handlers.set(channel, fn) } };`,
        store: `import { state } from 'inference-test-state'; export const storeManager = { getConfig: () => ({modelFeatureDefaults:{thinking:'auto',vision:'auto'}}), addLog: (...args) => state.logs.push(args), addRequestLog: value => {state.logs.push(value); return {id:'log-1'}}, updateRequestLog: (...args) => state.updates.push(args), recordTokenUsage: (...args) => state.tokens.push(args) };`,
        modelCatalog: `export const listAvailableModels = () => [{id:'remote-model',object:'model',owned_by:'remote'}];`,
        modelVerification: `import { state } from 'inference-test-state'; export const verifyModelSelection = async (...args) => {state.verification=args; return {success:true,value:{model:args[0],verified:false,skipped:true,recovered:args[1]}}};`,
        stream: `import { PassThrough } from 'node:stream'; import { state } from 'inference-test-state'; export const streamHandler = { createTransformStream: (...args) => {state.transforms.push(args); return new PassThrough()} };`,
        dispatch: `import { PassThrough } from 'node:stream'; import { state } from 'inference-test-state';
          export async function dispatchChatCompletion(request,id,client,headers,signal) {
            state.calls.push({request,id,client,headers,signal});
            const selection={actualModel:'upstream-model',provider:{id:'provider',name:'Remote'},account:{id:'account',name:'Account'}};
            if(request.model==='pending') return new Promise(resolve => signal.addEventListener('abort',()=>resolve({result:{success:false,status:499,error:'cancelled'}}),{once:true}));
            if(request.model==='unavailable') return {result:{success:false,status:503,error:'No available account'}};
            if(request.stream) {state.source=new PassThrough(); return {selection,result:{success:true,stream:state.source,skipTransform:request.model!=='transform'},finishStream:error=>state.finishes.push(error)}};
            return {selection,result:{success:true,body:{id:'completion',choices:[{message:{role:'assistant',content:'remote answer'}}],usage:{total_tokens:12}}}};
          }`,
      }[args.path] }))
    } }],
  })
  module = await import(pathToFileURL(output).href)
  test.mock.method(module.kiloFreeModels, 'get', async () => ({ models: [], stale: false, updatedAt: 1000 }))
})
beforeEach(() => module.reset())
after(async () => { await rm(output, { force: true }) })

const chat = (model = 'remote-model', extra = {}) => ({ id: 'request-1', path: '/v1/chat/completions', method: 'POST', body: { model, messages: [{ role: 'user', content: 'hello' }], ...extra } })
const signal = () => new AbortController().signal
async function drain(stream) { let output = ''; for await (const chunk of stream) output += chunk.toString(); return output }
function ownerFixture() {
  const owner = new EventEmitter()
  owner.mainFrame = { url: 'file:///renderer/index.html' }
  owner.isDestroyed = () => false
  owner.send = (channel, value) => { owner.emit('data', value); owner.events.push(value) }
  owner.events = []
  const dispose = module.registerInternalInferenceHandlers({ webContents: owner })
  const event = { sender: owner, senderFrame: owner.mainFrame }
  const request = input => module.ipcMain.handlers.get('inference:request')(event, input)
  const cancel = id => module.ipcMain.handlers.get('inference:cancel')(event, id)
  return { owner, event, request, cancel, dispose }
}

test('desktop catalog and verification work directly without a proxy listener', async () => {
  const catalog = await module.executeInternalInference({ id: 'catalog', path: '/v1/models' }, signal())
  assert.equal(catalog.response.body.data[0].id, 'remote-model')
  const verified = await module.executeInternalInference({ id: 'verify', path: '/v1/models/verify', body: { model: ' remote-model ', recover: true } }, signal())
  assert.equal(verified.response.body.model, 'remote-model')
  assert.equal(module.state.verification[1], true)
  assert.equal(module.state.calls.length, 0)
})

test('direct completion preserves feature flags, explicit routing and request logs', async () => {
  const response = await module.executeInternalInference({ ...chat(), headers: { 'X-DailyWorkMate-Model-Selection': 'explicit', 'X-Enable-Thinking': 'false', 'X-Web-Search': 'true' } }, signal())
  assert.equal(response.response.status, 200)
  assert.equal(response.response.body.choices[0].message.content, 'remote answer')
  const call = module.state.calls[0]
  assert.equal(call.request.enable_thinking, false)
  assert.equal(call.request.web_search, true)
  assert.equal(call.headers['x-dailyworkmate-model-selection'], 'explicit')
  assert.equal(call.client, 'desktop')
  assert.equal(module.state.logs[0].actualModel, 'upstream-model')
  assert.equal(module.state.logs[0].providerId, 'provider')
})

test('streaming completes dispatch exactly once and retains usage and response logs', async () => {
  const response = await module.executeInternalInference(chat('transform', { stream: true }), signal())
  assert.equal(response.response.stream, true)
  assert.equal(module.state.transforms[0][0], 'upstream-model')
  const content = 'data: {"choices":[{"delta":{"content":"回答"}}],"usage":{"total_tokens":17}}\n\ndata: [DONE]\n\n'
  module.state.source.end(content)
  assert.equal(await drain(response.output), content)
  assert.equal(module.state.finishes.length, 1)
  assert.equal(module.state.finishes[0], undefined)
  assert.deepEqual(module.state.tokens, [['transform', 17]])
  assert.equal(module.state.updates[0][1].responseBody.trim(), content.trim())
})

test('cancelling a running stream releases its source and records failure', async () => {
  const controller = new AbortController()
  const response = await module.executeInternalInference(chat('stream', { stream: true }), controller.signal)
  const consume = drain(response.output)
  controller.abort()
  await assert.rejects(consume, /cancelled/)
  assert.equal(module.state.source.destroyed, true)
  assert.equal(module.state.finishes.length, 1)
  assert.ok(module.state.finishes[0] instanceof Error)
  assert.equal(module.state.updates[0][1].status, 'error')
})

test('invalid bodies, arbitrary endpoints and sensitive headers cannot reach dispatch', async () => {
  for (const input of [
    { ...chat(), path: 'http://127.0.0.1:11434/v1/chat/completions' },
    { ...chat(), method: 'DELETE' },
    { ...chat(), headers: { Authorization: 'secret' } },
    { ...chat(), headers: { 'x-web-search': 'true\r\nAuthorization: secret' } },
    { ...chat(), id: '../invalid' },
    { ...chat(), body: '{invalid' },
  ]) assert.throws(() => module.validateInferenceRequest(input))
  const result = await module.executeInternalInference({ ...chat(), body: { model: 'remote-model', messages: [] } }, signal())
  assert.equal(result.response.status, 400)
  assert.equal(module.state.calls.length, 0)
  const missing = await module.executeInternalInference(chat('unavailable'), signal())
  assert.equal(missing.response.status, 503)
  assert.equal(module.state.logs[0].status, 'error')
})

test('IPC rejects foreign frames and duplicate active request IDs; cancellation aborts model loading', async () => {
  const fixture = ownerFixture()
  try {
    const handler = module.ipcMain.handlers.get('inference:request')
    await assert.rejects(handler({ ...fixture.event, senderFrame: {} }, chat()), /Untrusted/)
    await assert.rejects(handler({ ...fixture.event, sender: {} }, chat()), /Untrusted/)
    const pending = fixture.request(chat('pending'))
    await assert.rejects(fixture.request(chat('pending')), /already active/)
    fixture.cancel('request-1')
    const response = await pending
    assert.equal(response.status, 499)
    assert.equal(module.state.calls[0].signal.aborted, true)
  } finally { fixture.dispose() }
})

test('IPC preserves split UTF-8 characters and publishes a final stream event', async () => {
  const fixture = ownerFixture()
  try {
    const response = await fixture.request(chat('stream', { stream: true }))
    assert.equal(response.stream, true)
    const content = 'data: {"content":"中文"}\n\ndata: [DONE]\n\n'
    const encoded = Buffer.from(content)
    const done = new Promise(resolve => fixture.owner.on('data', event => { if (event.done) resolve(event) }))
    for (const byte of encoded) module.state.source.write(Buffer.from([byte]))
    module.state.source.end()
    await done
    assert.equal(fixture.owner.events.map(event => event.data || '').join(''), content)
    assert.equal(fixture.owner.events.at(-1).done, true)
  } finally { fixture.dispose() }
})

test('page switches keep pending inference alive; replacing the renderer aborts it', async () => {
  const fixture = ownerFixture()
  try {
    const pending = fixture.request(chat('pending'))
    fixture.owner.emit('did-start-navigation', {}, 'file:///renderer/index.html#/chat', true, true)
    assert.equal(module.state.calls[0].signal.aborted, false)
    fixture.owner.emit('did-start-navigation', {}, 'file:///renderer/index.html', false, true)
    await pending
    assert.equal(module.state.calls[0].signal.aborted, true)
  } finally { fixture.dispose() }
})

test('an abort between dispatch and IPC stream setup releases the upstream without publishing data', async () => {
  const fixture = ownerFixture()
  try {
    const pending = fixture.request(chat('stream', { stream: true }))
    const closed = once(module.state.source, 'close')
    fixture.cancel('request-1')
    assert.equal((await pending).status, 499)
    await closed
    assert.equal(module.state.source.destroyed, true)
    assert.equal(module.state.finishes.length, 1)
    assert.deepEqual(fixture.owner.events, [])
  } finally { fixture.dispose() }
})

test('IPC bounds concurrent requests and renderer destruction cancels every pending load', async () => {
  const fixture = ownerFixture()
  try {
    const requests = Array.from({ length: 16 }, (_, index) => fixture.request({ ...chat('pending'), id: `pending-${index}` }))
    await assert.rejects(fixture.request({ ...chat('pending'), id: 'overflow' }), /Too many concurrent/)
    fixture.owner.emit('destroyed')
    const responses = await Promise.all(requests)
    assert.ok(responses.every(response => response.status === 499))
    assert.ok(module.state.calls.every(call => call.signal.aborted))
    assert.equal(module.ipcMain.handlers.has('inference:request'), false)
  } finally { fixture.dispose() }
})

test('stream failures retain OpenAI error framing and settle dispatch as failed', async () => {
  const response = await module.executeInternalInference(chat('stream', { stream: true }), signal())
  const consume = drain(response.output)
  module.state.source.destroy(new Error('Upstream disconnected'))
  const content = await consume
  assert.match(content, /Upstream disconnected/)
  assert.match(content, /data: \[DONE\]/)
  assert.equal(module.state.finishes.length, 1)
  assert.equal(module.state.finishes[0].message, 'Upstream disconnected')
  assert.equal(module.state.updates[0][1].status, 'error')
})

test('re-registering inference removes previous window listeners without removing new handlers later', async () => {
  const previous = ownerFixture()
  const current = ownerFixture()
  try {
    assert.equal(previous.owner.listenerCount('did-start-navigation'), 0)
    previous.owner.emit('destroyed')
    previous.dispose()
    assert.equal((await current.request({ id: 'models', path: '/v1/models' })).status, 200)
    assert.equal(current.owner.listenerCount('did-start-navigation'), 1)
  } finally { current.dispose(); previous.dispose() }
})
