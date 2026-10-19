// Real chat and Claude routes, dispatch, load balancer and forwarder against mock official APIs.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import Koa from 'koa'
import bodyParser from 'koa-bodyparser'

const output = path.resolve('tmp/qa/api-forwarding.mjs')
let upstream, proxy, endpoint, module
const received = []
before(async () => {
  await mkdir(path.dirname(output), { recursive: true })
  await build({
    stdin: { contents: `export { default as chat } from './src/main/proxy/routes/chat.ts'; export { default as claude } from './src/main/proxy/routes/claude.ts'; export { setup, state } from './src/main/store/store'`, resolveDir: process.cwd() },
    outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external',
    plugins: [{ name: 'isolate-store', setup(builder) {
      builder.onResolve({ filter: /(?:^electron$|\/store\/store(?:\.ts)?$)/ }, args => ({ path: args.path === 'electron' ? 'electron' : 'store', namespace: 'qa' }))
      builder.onLoad({ filter: /.*/, namespace: 'qa' }, args => ({ contents: args.path === 'electron'
        ? 'export const app = { isPackaged:false }; export const net = {}; export const shell = {}; export class BrowserWindow {}'
        : `import { DEFAULT_CONFIG } from './src/main/store/types.ts';
          export const state = { logs: [], requests: [], providers: [], accounts: [] };
          export const setup = base => {
            const api = (id, preset, protocol, model, apiKey) => ({ provider: { id, name: id, type: 'custom', authType: 'token', apiEndpoint: base + (protocol === 'anthropic' ? '' : '/v1'), chatPath: protocol === 'anthropic' ? '/v1/messages' : '/chat/completions', headers: {}, enabled: true, supportedModels: [model], modelMappings: { [model]: model }, upstreamKind: 'api', apiPreset: preset, apiProtocol: protocol, createdAt: 0, updatedAt: 0 },
              account: { id: id + '-key', providerId: id, name: id, status: 'active', credentials: { apiKey } } })
            const entries = [api('api-openai', 'openai', 'openai', 'gpt-qa', 'sk-openai'), api('api-anthropic', 'anthropic', 'anthropic', 'claude-qa', 'sk-ant-qa')]
            state.providers = entries.map(entry => entry.provider); state.accounts = entries.map(entry => entry.account)
          };
          export const storeManager = {
            getConfig: () => ({ ...DEFAULT_CONFIG, retryCount: 0 }), getSessionConfig: () => DEFAULT_CONFIG.sessionConfig,
            getProviders: () => state.providers, getProviderById: id => state.providers.find(provider => provider.id === id),
            getEffectiveModels: id => (state.providers.find(provider => provider.id === id)?.supportedModels || []).map(model => ({ displayName: model, actualModelId: model })),
            getAccountsByProviderId: id => state.accounts.filter(account => account.providerId === id), getAccountById: id => state.accounts.find(account => account.id === id),
            updateAccount: (id, updates) => { state.accounts = state.accounts.map(account => account.id === id ? { ...account, ...updates } : account) },
            addLog: (...args) => state.logs.push(args), recordRequestInStats: () => {}, recordAccountUsage: () => {}, updateProvider: () => null, recordTokenUsage: () => {},
            addRequestLog: log => { const entry = { ...log, id: String(state.requests.length) }; state.requests.push(entry); return entry }, updateRequestLog: () => {},
          }`, resolveDir: process.cwd() }))
    } }],
  })
  module = await import(pathToFileURL(output))
  upstream = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    received.push({ url: req.url, headers: req.headers, body })
    const last = JSON.stringify(body.messages?.at(-1) || '')
    if (last.includes('REJECT')) { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { type: 'authentication_error', message: 'invalid x-api-key' } })); return }
    if (req.url === '/v1/messages') {
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const send = event => res.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n')
        send({ type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: 3, output_tokens: 0 } } })
        send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Claude streamed' } })
        send({ type: 'content_block_stop', index: 0 })
        send({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } })
        send({ type: 'message_stop' }); res.end(); return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: body.model, stop_reason: body.tools ? 'tool_use' : 'end_turn', usage: { input_tokens: 3, output_tokens: 2 },
        content: [{ type: 'text', text: 'Claude answer' }, ...(body.tools ? [{ type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 'x' } }] : [])] }))
      return
    }
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: ' + JSON.stringify({ id: 'c', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content: 'OpenAI streamed' }, finish_reason: null }] }) + '\n\n')
      res.write('data: ' + JSON.stringify({ id: 'c', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n')
      res.end('data: [DONE]\n\n'); return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'c', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'OpenAI answer' }, finish_reason: 'stop' }] }))
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  module.setup(`http://127.0.0.1:${upstream.address().port}`)
  const app = new Koa()
  app.use(bodyParser({ jsonLimit: '10mb' }))
  for (const router of [module.chat, module.claude]) app.use(router.routes())
  proxy = createServer(app.callback())
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  endpoint = `http://127.0.0.1:${proxy.address().port}`
})
after(async () => {
  for (const server of [proxy, upstream]) { server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve)) }
  await rm(output, { force: true })
})
const chat = body => fetch(endpoint + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

test('OpenAI-protocol API keys use the generic path with a Bearer key', async () => {
  const response = await chat({ model: 'gpt-qa', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).choices[0].message.content, 'OpenAI answer')
  const sent = received.at(-1)
  assert.equal(sent.url, '/v1/chat/completions')
  assert.equal(sent.headers.authorization, 'Bearer sk-openai')
  assert.equal(sent.body.model, 'gpt-qa')
  const streamed = await (await chat({ model: 'gpt-qa', stream: true, messages: [{ role: 'user', content: 'hi' }] })).text()
  assert.match(streamed, /OpenAI streamed/)
  assert.match(streamed, /\[DONE\]/)
})

test('Claude API keys use the Messages API and come back in OpenAI format', async () => {
  const response = await chat({ model: 'claude-qa', messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }], temperature: 0.3, top_p: 1,
    tools: [{ type: 'function', function: { name: 'lookup', description: 'find', parameters: { type: 'object', properties: { q: { type: 'string' } } } } }] })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.choices[0].message.content, 'Claude answer')
  assert.equal(body.choices[0].message.tool_calls[0].function.name, 'lookup')
  const sent = received.at(-1)
  assert.equal(sent.url, '/v1/messages')
  assert.equal(sent.headers['x-api-key'], 'sk-ant-qa')
  assert.equal(sent.headers['anthropic-version'], '2023-06-01')
  assert.equal(sent.headers.authorization, undefined, 'the key is not sent as a Bearer token')
  assert.equal(sent.body.system, 'be brief')
  assert.equal(sent.body.max_tokens, 8192)
  assert.equal(sent.body.tools[0].input_schema.type, 'object')
  assert.equal('top_p' in sent.body, false)
  const streamed = await (await chat({ model: 'claude-qa', stream: true, messages: [{ role: 'user', content: 'hi' }] })).text()
  assert.match(streamed, /"content":"Claude streamed"/)
  assert.match(streamed, /\[DONE\]/)
})

test('Claude clients reach the official Claude API through /v1/messages', async () => {
  const response = await fetch(endpoint + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-qa', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }) })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).content[0].text, 'Claude answer')
  assert.equal(received.at(-1).body.max_tokens, 64)
})

test('a refused key surfaces the vendor message and status', async () => {
  const response = await chat({ model: 'claude-qa', messages: [{ role: 'user', content: 'REJECT' }] })
  assert.equal(response.status, 401)
  assert.match(JSON.stringify(await response.json()), /invalid x-api-key/)
})
