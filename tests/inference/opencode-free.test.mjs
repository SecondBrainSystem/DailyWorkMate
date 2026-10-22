import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const output = path.resolve('tmp/qa/opencode-free-transport-test.mjs')
let api
const model = { id: 'opencode-free/qa-free', apiModel: 'qa-free', name: 'QA', protocol: 'chat-completions',
  toolCall: true, vision: false, reasoning: true, temperature: true, contextLimit: 128000, outputLimit: 8000 }
const request = extra => ({ model: model.id, messages: [{ role: 'user', content: 'hello' }], ...extra })
const tool = name => ({ type: 'function', function: { name, description: 'Caller tool', parameters: { type: 'object', properties: { file: { type: 'string' } } } } })
before(async () => {
  await mkdir(path.dirname(output), { recursive: true })
  await build({ stdin: { contents: "export * from './src/main/inference/opencodeTransport.ts'", resolveDir: process.cwd() },
    outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external' })
  api = await import(pathToFileURL(output))
})
after(async () => { await rm(output, { force: true }) })

test('OpenCode wire uses fixed endpoint and public identity, preserving caller input and bounded output', () => {
  const input = request({ enable_thinking: false, max_tokens: 999999, apiKey: 'do-not-forward', endpoint: 'https://untrusted.invalid' })
  const original = structuredClone(input)
  const wire = api.buildOpenCodeWire(input, model, { authorization: 'Bearer local-only' })
  assert.equal(wire.url, 'https://opencode.ai/inference/v1/chat/completions')
  assert.equal(wire.headers.Authorization, 'Bearer public')
  assert.equal(wire.headers['User-Agent'], 'opencode/latest/2.0.26/cli')
  assert.equal(wire.headers['x-opencode-request'], undefined)
  assert.ok(!JSON.stringify(wire).includes('local-only'))
  assert.equal(wire.body.apiKey, undefined); assert.equal(wire.body.endpoint, undefined)
  assert.equal(wire.body.max_tokens, 8000); assert.equal(wire.body.reasoning_effort, 'none')
  assert.deepEqual(wire.body.tools.map(t => t.function.name), ['read','shell'])
  assert.equal(new Set(['x-opencode-session','x-opencode-session-id','x-session-id','x-session-affinity'].map(key => wire.headers[key])).size, 1)
  assert.deepEqual(input, original)
})

test('session identity has descending encoding, persists over full-history turns and never exposes local keys', () => {
  const headers = { authorization: 'Bearer client-a' }
  const first = api.openCodeProxySession(request(), headers)
  assert.match(first, /^ses_[a-f0-9]{9}f[c-f][a-f0-9][0-9A-Za-z]{14}$/)
  assert.equal(first, api.openCodeProxySession(request({ messages: [...request().messages, { role: 'assistant', content: 'answer' }, { role: 'user', content: 'more' }] }), headers))
  assert.notEqual(first, api.openCodeProxySession(request(), { authorization: 'Bearer client-b' }))
  assert.equal(api.openCodeProxySession(request({ session_id: 'same' })), api.openCodeProxySession(request({ session_id: 'same', messages: [{ role: 'user', content: 'different' }] })))
  for (const session_id of ['', 'bad\r\nheader', 123, 'a'.repeat(257)]) assert.throws(() => api.openCodeProxySession(request({ session_id })), /session ID/)
})

test('colliding client tools, history and explicit choice are renamed together and fragmented calls restore their original name', () => {
  const input = request({ tools: [tool('read'),tool('read_client'),tool('shell')],
    tool_choice: { type: 'function', function: { name: 'read' } },
    messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'old', type: 'function', function: { name: 'read', arguments: '{}' } }] },
      { role: 'tool', content: 'previous result', tool_call_id: 'old' }, ...request().messages] })
  const wire = api.buildOpenCodeWire(input, model)
  assert.equal(wire.body.tool_choice.function.name, 'read_client2')
  assert.equal(wire.body.messages.find(m => m.tool_calls).tool_calls[0].function.name, 'read_client2')
  assert.deepEqual(wire.body.tools.map(t => t.function.name), ['read_client2','read_client','shell_client','read','shell'])
  const packet = (delta, finish = null) => ({ choices: [{ index: 0, delta, finish_reason: finish }] })
  assert.equal(wire.transformPacket(packet({ tool_calls: [{ index: 0, id: 'call', function: { name: 'read_cl', arguments: '{"file":' } }] })).choices[0].delta.tool_calls, undefined)
  wire.transformPacket(packet({ tool_calls: [{ index: 0, function: { name: 'ient2', arguments: '"a.txt"}' } }] }))
  const completed = wire.transformPacket(packet({}, 'tool_calls')).choices[0].delta.tool_calls[0]
  assert.equal(completed.function.name, 'read'); assert.equal(completed.function.arguments, '{"file":"a.txt"}')
  wire.finalize()
})

test('injected or undeclared tools and tool_choice none fail without exposing a call to the client', () => {
  for (const extra of [{}, { tools: [tool('read')] }, { tools: [tool('custom')], tool_choice: 'none' }]) {
    const wire = api.buildOpenCodeWire(request(extra), model)
    assert.notEqual(wire.body.tool_choice, 'none')
    assert.throws(() => wire.transformPacket({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call', function: { name: extra.tool_choice === 'none' ? 'custom' : 'read', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }), /undeclared tool/)
  }
  const wire = api.buildOpenCodeWire(request({ tools: [tool('custom')] }), model)
  wire.transformPacket({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'custom', arguments: '{' } }] } }] })
  assert.throws(() => wire.finalize(), /before completion/)
})

test('capabilities and future unsupported protocols are rejected explicitly', () => {
  for (const input of [request({ n: 2 }), request({ max_tokens: 0 }), request({ web_search: true }),
    request({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] }] }),
    request({ tools: [tool('same'),tool('same')] })]) assert.throws(() => api.buildOpenCodeWire(input, model))
  assert.throws(() => api.buildOpenCodeWire(request({ tool_choice: 'required' }), model), /tool_choice/)
  const required = api.buildOpenCodeWire(request({ tools: [tool('custom')], tool_choice: 'required' }), model)
  assert.throws(() => required.transformPacket({ choices: [{ delta: { content: 'no tool' }, finish_reason: 'stop' }] }), /required client tool/)
  assert.throws(() => api.buildOpenCodeWire(request(), { ...model, protocol: 'responses' }), /protocol/)
})

test('nonstream and SSE preserve text, reasoning, usage and client tool names; injected tools fail both formats', async () => {
  const resolve = async () => model
  for (const stream of [false, true]) {
    const result = await api.forwardOpenCodeCompletion(request({ stream, tools: [tool('read')] }), {}, undefined, 5000, { resolve,
      fetch: async () => new Response(JSON.stringify({ id: 'completion', created: 10, choices: [{ index: 0, message: { role: 'assistant', content: 'OK', reasoning: 'thought',
        tool_calls: [{ id: 'call', type: 'function', function: { name: 'read_client', arguments: '{}' } }] }, finish_reason: 'tool_calls' }], usage: { total_tokens: 8 } })) })
    assert.equal(result.success, true)
    if (stream) { let output = ''; for await (const chunk of result.stream) output += chunk; assert.match(output, /"name":"read"/); assert.match(output, /reasoning_content/); assert.match(output, /\[DONE\]/) }
    else { assert.equal(result.body.choices[0].message.tool_calls[0].function.name, 'read'); assert.equal(result.body.usage.total_tokens, 8) }
    const failure = await api.forwardOpenCodeCompletion(request({ stream }), {}, undefined, 5000, { resolve,
      fetch: async () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: 'shell', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })) })
    if (stream) await assert.rejects(async () => { for await (const _chunk of failure.stream) {} }, /undeclared tool/)
    else { assert.equal(failure.success, false); assert.equal(failure.status, 502) }
  }
})

test('OpenCode quota errors retain upstream details and status in HTTP and SSE responses', async () => {
  const detail = 'Free usage limit reached. Subscribe to OpenCode Go to keep going: https://opencode.ai/go'
  const resolve = async () => model
  for (const status of [403, 429]) {
    const result = await api.forwardOpenCodeCompletion(request({stream:false}), {}, undefined, 5000, {resolve,
      fetch: async () => new Response(JSON.stringify({error:{message:detail}}), {status,headers:{'retry-after':'60'}})})
    assert.equal(result.success, false)
    assert.equal(result.status, status)
    assert.ok(result.error.includes(detail))
    assert.equal(result.retryAfterMs, 60000)
  }
  const result = await api.forwardOpenCodeCompletion(request({stream:false}), {}, undefined, 5000, {resolve,
    fetch: async () => new Response('data: '+JSON.stringify({error:{message:detail}})+'\n\n')})
  assert.equal(result.success, false)
  assert.equal(result.status, 429)
  assert.ok(result.error.includes(detail))
})
