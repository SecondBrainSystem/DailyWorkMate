import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import {
  createOllamaNdjsonToOpenAIStream, createOpenAISseToOllamaStream,
  ollamaRequestToOpenAI, openAIToOllamaChat, openAIToOllamaGenerate,
  openAIResponseToOllama, claudeRequestToOpenAI, openAIToClaudeRequest,
} from '../../src/main/proxy/ollamaProtocol.ts'
import { normalizeFeatureRequest } from '../../src/main/proxy/modelFeatures.ts'

const request = { model: 'model', messages: [{ role: 'user' as const, content: 'hello' }] }
async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  let output = ''
  for await (const chunk of stream) output += chunk.toString()
  return output
}

test('parallel Ollama tool calls in separate chunks remain separate after a protocol round trip', async () => {
  const frames = ['Berlin', 'Paris'].map(city => ({ message: { tool_calls: [{ function: { name: 'weather', arguments: { city } } }] }, done: false }))
  const source = [...frames, { done: true, done_reason: 'stop', eval_count: 7 }].map(frame => JSON.stringify(frame)).join('\n')
  const openai = await collect(Readable.from([source]).pipe(createOllamaNdjsonToOpenAIStream('model')))
  const calls = openai.split('\n').filter(line => line.startsWith('data: {')).flatMap(line => JSON.parse(line.slice(6)).choices?.[0]?.delta?.tool_calls || [])
  assert.deepEqual(calls.map(call => call.index), [0, 1])
  assert.equal(new Set(calls.map(call => call.id)).size, 2)
  const native = await collect(Readable.from([openai]).pipe(createOpenAISseToOllamaStream('model')))
  const final = JSON.parse(native.trim().split('\n').at(-1)!)
  assert.deepEqual(final.message.tool_calls.map((call: any) => call.function.arguments.city), ['Berlin', 'Paris'])
  assert.equal(final.done_reason, 'stop')
  assert.equal(final.eval_count, 7)
})

test('Ollama tool results and thinking retain their association through OpenAI', () => {
  const native = { model: 'model', messages: [
    { role: 'assistant', thinking: 'check cities', tool_calls: ['weather', 'clock', 'weather'].map(name => ({ function: { name, arguments: {} } })) },
    { role: 'tool', tool_name: 'clock', content: 'noon' },
    { role: 'tool', tool_name: 'weather', content: 'sunny' },
    { role: 'tool', tool_name: 'weather', content: 'rain' },
  ] }
  const translated = ollamaRequestToOpenAI(native)
  const calls = translated.messages[0].tool_calls!
  assert.deepEqual(translated.messages.slice(1).map(message => message.tool_call_id), [calls[1].id, calls[0].id, calls[2].id])
  assert.equal(translated.messages[0].reasoning_content, 'check cities')
  const roundTrip = openAIToOllamaChat(translated, 'model') as any
  assert.equal(roundTrip.messages[0].thinking, 'check cities')
  assert.deepEqual(roundTrip.messages.slice(1).map((message: any) => message.tool_name), ['clock', 'weather', 'weather'])
})

test('native images and output format become valid OpenAI fields', () => {
  const translated = ollamaRequestToOpenAI({ ...request, messages: [{ role: 'user', images: ['AAAA'] }], format: { type: 'object' }, options: { seed: 42, frequency_penalty: 0.7 } })
  assert.match((translated.messages[0].content as any[])[1].image_url.url, /^data:image\/[^;]+;base64,AAAA$/)
  assert.equal(translated.seed, 42)
  assert.equal(translated.frequency_penalty, 0.7)
  assert.deepEqual(translated.response_format?.json_schema?.schema, { type: 'object' })
})

test('frequency penalties are not silently replaced with repetition penalties', () => {
  const payload = openAIToOllamaChat({ ...request, frequency_penalty: -0.5 }, 'model') as any
  assert.equal(payload.options.frequency_penalty, -0.5)
  assert.equal(payload.options.repeat_penalty, undefined)
})

test('unsupported native tool choices and generate tools fail instead of being ignored', () => {
  const tools = [{ type: 'function' as const, function: { name: 'weather' } }]
  assert.equal(openAIToOllamaChat({ ...request, tools, tool_choice: 'none' }, 'model').tools, undefined)
  assert.throws(() => openAIToOllamaChat({ ...request, tools, tool_choice: 'required' }, 'model'), /tool_choice/)
  assert.throws(() => openAIToOllamaGenerate({ ...request, tools }, 'model'), /tool/i)
})

test('invalid tool payloads and unknown content types fail at the request boundary', () => {
  for (const invalid of [null, { type: 'function' }, { type: 'function', function: { name: '', arguments: '{}' } }]) {
    assert.throws(() => normalizeFeatureRequest({ ...request, messages: [{ role: 'assistant', content: null, tool_calls: [invalid] }] } as any), /tool/i)
  }
  assert.throws(() => normalizeFeatureRequest({ ...request, messages: [{ role: 'user', content: [{ type: 'audio' }] }] } as any), /content/i)
  assert.throws(() => ollamaRequestToOpenAI({ ...request, options: [] }), /options/)
  assert.throws(() => ollamaRequestToOpenAI({ ...request, messages: [{ role: 'tool', tool_name: 'missing', content: 'result' }] }), /tool/i)
  assert.doesNotThrow(() => normalizeFeatureRequest({ ...request, messages: [{ role: 'assistant', tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: '{}' } }] }] } as any))
})

test('OpenAI tool completion has a valid Ollama stop reason', () => {
  const response = openAIResponseToOllama({ choices: [{ message: { content: '' }, finish_reason: 'tool_calls' }] }, 'model')
  assert.equal(response.done_reason, 'stop')
})

test('Claude tool selection and stop sequences survive both protocol boundaries', () => {
  for (const choice of [{ type: 'auto' }, { type: 'any' }, { type: 'none' }, { type: 'tool', name: 'weather' }]) {
    const translated = normalizeFeatureRequest(claudeRequestToOpenAI({ ...request, tool_choice: choice, stop_sequences: ['END'] }))
    const roundTrip = openAIToClaudeRequest(translated, 'model')
    assert.deepEqual(roundTrip.tool_choice, choice)
    assert.deepEqual(roundTrip.stop_sequences, ['END'])
  }
  assert.deepEqual(openAIToClaudeRequest({ ...request, stop: 'END', max_completion_tokens: 2048 }, 'model').stop_sequences, ['END'])
  assert.equal(openAIToClaudeRequest({ ...request, max_completion_tokens: 2048 }, 'model').max_tokens, 2048)
  assert.throws(() => claudeRequestToOpenAI({ ...request, tool_choice: { type: 'tool' } }), /tool_choice/)
})
