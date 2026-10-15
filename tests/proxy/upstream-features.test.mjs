import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import { mkdir, rm } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const output = path.resolve('tmp/qa/upstream-features-test.mjs')
let OllamaAdapter, RequestForwarder, server, endpoint
let received = []
let status = 200
let response = { message: { role: 'assistant', content: 'ok' }, done: true }
before(async () => {
  await mkdir(path.dirname(output), { recursive: true })
  await build({
    stdin: { contents: `export { OllamaAdapter } from './src/main/proxy/adapters/ollama.ts'; export { RequestForwarder } from './src/main/proxy/forwarder.ts'`, resolveDir: process.cwd() },
    outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external',
    plugins: [{ name: 'isolate-test-storage', setup(builder) {
      builder.onResolve({ filter: /(?:^electron$|\/store\/store(?:\.ts)?$)/ }, args => ({ path: args.path === 'electron' ? 'electron' : 'store', namespace: 'qa' }))
      builder.onLoad({ filter: /.*/, namespace: 'qa' }, args => ({
        contents: args.path === 'electron'
          ? `export const app = { isPackaged:false }; export const net = {}; export const shell = {}; export class BrowserWindow {}`
          : `import { DEFAULT_CONFIG } from './src/main/store/types.ts'; export const storeManager = { getConfig: () => ({...DEFAULT_CONFIG, retryCount:0}), getSessionConfig: () => DEFAULT_CONFIG.sessionConfig, addLog: () => {} };`,
        resolveDir: process.cwd(),
      }))
    } }],
  })
  ;({ OllamaAdapter, RequestForwarder } = await import(pathToFileURL(output)))
  server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    received = [...received, { path: req.url, body: JSON.parse(raw) }]
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(response))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  endpoint = `http://127.0.0.1:${server.address().port}`
})
after(async () => { server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve)); await rm(output, { force: true }) })

const account = { id: 'qa', credentials: {}, providerId: 'qa' }
const request = { model: 'qwen3', messages: [{ role: 'user', content: 'hello' }], stream: false }
function provider(transport, model = 'qwen3') { return { id: 'qa', name: 'QA', type: 'custom', upstreamKind: 'ollama', apiEndpoint: endpoint, ollamaModels: { [model]: { name: model, endpoint: transport, vision: 'unknown' } } } }

test('Ollama HTTP payloads use endpoint-specific thinking controls', async () => {
  status = 200
  for (const transport of ['ollama_chat', 'ollama_generate', 'openai_chat', 'claude_chat']) {
    response = transport === 'ollama_chat' ? { message: { content: 'ok' }, done: true }
      : transport === 'ollama_generate' ? { response: 'ok', done: true }
        : transport === 'openai_chat' ? { choices: [{ message: { content: 'ok' } }] }
          : { content: [{ type: 'text', text: 'ok' }] }
    const result = await OllamaAdapter.forward({ ...request, enable_thinking: false }, account, provider(transport), 'qwen3', 2000)
    assert.equal(result.success, true)
    const body = received.at(-1).body
    if (transport.startsWith('ollama')) assert.equal(body.think, false)
    if (transport === 'openai_chat') {
      assert.equal(body.reasoning_effort, 'none')
      assert.equal(body.enable_thinking, undefined)
      assert.equal(body.think, undefined)
    }
    if (transport === 'claude_chat') assert.deepEqual(body.thinking, { type: 'disabled' })
  }
})

test('OpenAI URL images do not pass through a native base64 converter', async () => {
  response = { choices: [{ message: { content: 'ok' } }] }
  const content = [{ type: 'image_url', image_url: { url: 'https://example.com/picture.png' } }]
  const result = await OllamaAdapter.forward({ ...request, messages: [{ role: 'user', content }] }, account, provider('openai_chat'), 'qwen3', 2000)
  assert.equal(result.success, true)
  assert.deepEqual(received.at(-1).body.messages[0].content, content)
})

test('HTTP error bodies remain readable for streaming requests', async () => {
  status = 400
  response = { error: 'thinking is not supported' }
  const result = await OllamaAdapter.forward({ ...request, stream: true }, account, provider('ollama_chat'), 'qwen3', 2000)
  assert.equal(result.status, 400)
  assert.match(result.error, /thinking is not supported/)
})

test('generic APIs avoid web adapters, forward native tools and preserve HTTP 400', async () => {
  status = 400
  response = { error: { message: 'invalid user parameter' } }
  const tools = [{ type: 'function', function: { name: 'time', parameters: { type: 'object' } } }]
  const custom = { id: 'api-custom', name: 'Mimo custom API', type: 'custom', apiEndpoint: `${endpoint}/deepseek.com`, headers: {} }
  const previous = received.length
  const forwarder = new RequestForwarder()
  const result = await forwarder.forwardChatCompletion({ ...request, enable_thinking: false, tools, tool_choice: 'auto' }, account, custom, 'qwen3', {})
  assert.equal(result.status, 400)
  assert.equal(received.length, previous + 1)
  assert.equal(received.at(-1).path, '/deepseek.com/chat/completions')
  assert.deepEqual(received.at(-1).body.tools, tools)
  assert.equal(received.at(-1).body.enable_thinking, false)
})

test('generic streaming failures return the upstream error without serializing the HTTP stream', async () => {
  status = 400
  response = { error: { message: 'model rejects thinking disabled' } }
  const custom = { id: 'api-custom', name: 'Custom', type: 'custom', apiEndpoint: endpoint, headers: {} }
  const result = await new RequestForwarder().forwardChatCompletion({ ...request, stream: true, enable_thinking: false }, account, custom, 'qwen3', {})
  assert.equal(result.status, 400)
  assert.equal(result.error, response.error.message)
})

test('generic APIs preserve structured output, token limits and other declared controls', async () => {
  status = 200
  response = { choices: [{ message: { role: 'assistant', content: '{"ok":true}' } }] }
  const custom = { id: 'api-custom', name: 'Custom', type: 'custom', apiEndpoint: endpoint, headers: {} }
  const controls = {
    max_completion_tokens: 96,
    response_format: { type: 'json_schema', json_schema: { name: 'answer', schema: { type: 'object' }, strict: true } },
    seed: 0, parallel_tool_calls: false, stream_options: { include_usage: true },
  }
  const result = await new RequestForwarder().forwardChatCompletion({ ...request, ...controls }, account, custom, 'qwen3', {})
  assert.equal(result.success, true)
  for (const [key, value] of Object.entries(controls)) assert.deepEqual(received.at(-1).body[key], value, key)
})

test('generic APIs reject error or malformed success bodies returned with HTTP 200', async () => {
  status = 200
  const custom = { id: 'api-custom', name: 'Custom', type: 'custom', apiEndpoint: endpoint, headers: {} }
  for (const body of [{ error: { message: 'quota exhausted' } }, '<html>Sign in</html>', { choices: [] }, { choices: [{ delta: { content: 'stream chunk' } }] }]) {
    response = body
    const result = await new RequestForwarder().forwardChatCompletion(request, account, custom, 'qwen3', {})
    assert.equal(result.success, false, JSON.stringify(body))
    assert.equal(result.status, 502)
    if (body.error) assert.match(result.error, /quota exhausted/)
  }
})

test('generic APIs accept tool-only and refused completions', async () => {
  status = 200
  const custom = { id: 'api-custom', name: 'Custom', type: 'custom', apiEndpoint: endpoint, headers: {} }
  for (const message of [
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'time', arguments: '{}' } }] },
    { role: 'assistant', content: null, refusal: 'Cannot answer' },
  ]) {
    response = { choices: [{ message, finish_reason: 'stop' }] }
    const result = await new RequestForwarder().forwardChatCompletion(request, account, custom, 'qwen3', {})
    assert.equal(result.success, true)
    assert.deepEqual(result.body, response)
  }
})
