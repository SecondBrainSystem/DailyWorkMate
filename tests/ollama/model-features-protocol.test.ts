import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import {
  openAIToOllamaChat, openAIToOllamaGenerate, ollamaRequestToOpenAI,
  openAIToClaudeRequest, claudeRequestToOpenAI, createOllamaNdjsonToOpenAIStream,
  createClaudeToOpenAIStream, createOpenAISseToClaudeStream, createOpenAISseToOllamaStream,
  claudeToOpenAIResponse, openAIResponseToClaude,
} from '../../src/main/proxy/ollamaProtocol.ts'

const messages = [{ role: 'user' as const, content: [
  { type: 'text' as const, text: 'What is this?' },
  { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,AAAA' } },
] }]

test('Ollama native preserves levels, off, images and default streaming across conversions', () => {
  for (const think of [false, true, 'low', 'high', 'max'] as const) {
    const native = ollamaRequestToOpenAI({ model: 'qwen3', messages: [{ role: 'user', content: 'hi', images: ['AAAA'] }], think })
    assert.equal(native.stream, true)
    assert.equal(openAIToOllamaChat(native, 'qwen3').think, think)
  }
  const generate = openAIToOllamaGenerate({ model: 'qwen3-vl', messages, enable_thinking: false }, 'qwen3-vl')
  assert.equal(generate.think, false)
  assert.deepEqual(generate.images, ['AAAA'])
  assert.equal(openAIToOllamaGenerate({ model: 'qwen3-vl', messages, enable_vision: false }, 'qwen3-vl').images, undefined)
})

test('native Ollama rejects HTTP images rather than passing URLs as base64', () => {
  assert.throws(() => openAIToOllamaChat({ model: 'vision', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] }] }, 'vision'), /base64/)
})

test('Claude image MIME and thinking survive protocol round trips', () => {
  const native = openAIToClaudeRequest({ model: 'claude-sonnet-4', messages, enable_thinking: true, max_tokens: 4096 }, 'claude-sonnet-4') as any
  assert.deepEqual(native.messages[0].content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } })
  assert.deepEqual(native.thinking, { type: 'enabled', budget_tokens: 1024 })
  const roundTrip = claudeRequestToOpenAI(native)
  assert.deepEqual(roundTrip.messages, messages)
  assert.deepEqual(roundTrip.thinking, native.thinking)
  assert.deepEqual(openAIToClaudeRequest({ model: 'm', messages, enable_thinking: false }, 'm').thinking, { type: 'disabled' })
  assert.throws(() => openAIToClaudeRequest({ model: 'm', messages, enable_thinking: true, max_tokens: 1024 }, 'm'), /max_tokens/)
})

test('Ollama streams preserve UTF-8 split bytes, generate thinking, final lines and one DONE', async () => {
  const data = Buffer.from('{"thinking":"思考"}\n{"response":"回答","done":true,"eval_count":2}')
  const index = data.indexOf(Buffer.from('思')) + 1
  const stream = Readable.from([data.subarray(0, index), data.subarray(index)]).pipe(createOllamaNdjsonToOpenAIStream('model'))
  let output = ''
  for await (const chunk of stream) output += chunk.toString()
  assert.ok(output.includes('思考'))
  assert.ok(output.includes('回答'))
  assert.ok(output.includes('"completion_tokens":2'))
  assert.equal(output.match(/\[DONE\]/g)?.length, 1)
})

test('Ollama error frames are surfaced instead of successful empty output', async () => {
  const stream = Readable.from(['{"error":"model cannot think"}\n']).pipe(createOllamaNdjsonToOpenAIStream('model'))
  let output = ''
  for await (const chunk of stream) output += chunk.toString()
  assert.match(output, /"error":\{"message":"model cannot think"\}/)
})

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  let result = ''
  for await (const chunk of stream) result += chunk.toString()
  return result
}

test('Claude thinking survives streaming/non-streaming conversion with UTF-8 and usage', async () => {
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 3 } } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '思考' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '回答' } },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'call-1', name: 'weather', input: {} } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"city":"北京"}' } },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } },
    { type: 'message_stop' },
  ]
  const data = Buffer.from(events.map(event => `data: ${JSON.stringify(event)}`).join('\r\n\r\n'))
  const index = data.indexOf(Buffer.from('思')) + 1
  const openai = await collect(Readable.from([data.subarray(0, index), data.subarray(index)]).pipe(createClaudeToOpenAIStream('model')))
  assert.match(openai, /"reasoning_content":"思考"/)
  assert.match(openai, /"total_tokens":11/)
  assert.match(openai, /"name":"weather"/)
  assert.equal(openai.match(/\[DONE\]/g)?.length, 1)
  const claude = await collect(Readable.from([openai]).pipe(createOpenAISseToClaudeStream('model')))
  assert.match(claude, /"thinking":"思考"/)
  assert.match(claude, /"text":"回答"/)
  assert.match(claude, /"output_tokens":8/)
  assert.match(claude, /"type":"tool_use"/)
  assert.equal(claude.match(/event: message_stop/g)?.length, 1)
  const nonstream = claudeToOpenAIResponse({ content: [{ type: 'thinking', thinking: '思考' }, { type: 'text', text: '回答' }] }, 'model')
  assert.deepEqual(openAIResponseToClaude(nonstream, 'model').content, [{ type: 'thinking', thinking: '思考' }, { type: 'text', text: '回答' }])
})

test('Ollama stream buffers partial tool arguments and retains final usage exactly once', async () => {
  const chunks = [
    { choices: [{ delta: { reasoning_content: '思考', tool_calls: [{ index: 0, function: { name: 'weather', arguments: '{"city":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"北京"}' } }] }, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 3, completion_tokens: 5 } },
  ]
  const data = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]'
  const output = (await collect(Readable.from([data]).pipe(createOpenAISseToOllamaStream('model')))).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(output.filter(line => line.done).length, 1)
  assert.equal(output[0].message.thinking, '思考')
  assert.deepEqual(output.at(-1).message.tool_calls, [{ function: { name: 'weather', arguments: { city: '北京' } } }])
  assert.equal(output.at(-1).eval_count, 5)
})

test('truncated compatibility streams fail and native malformed inputs return actionable errors', async () => {
  for (const convert of [createClaudeToOpenAIStream, createOpenAISseToClaudeStream, createOpenAISseToOllamaStream]) {
    await assert.rejects(collect(Readable.from(['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n']).pipe(convert('m'))), /ended before/)
  }
  assert.throws(() => ollamaRequestToOpenAI({ model: 'm', messages: [{ role: 'user', content: 'hi', images: 'AAAA' }] }), /images must be an array/)
  assert.throws(() => claudeRequestToOpenAI({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: 'false' }), /stream must be a boolean/)
  assert.throws(() => claudeRequestToOpenAI({ model: 'm', messages: [null] }), /Invalid message/)
})
