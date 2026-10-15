import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import {
  claudeRequestToOpenAI,
  createOllamaNdjsonToOpenAIStream,
  createOpenAISseToOllamaStream,
  ollamaChatToOpenAI,
  ollamaRequestToOpenAI,
  openAIResponseToClaude,
  openAIResponseToOllama,
  openAIToOllamaChat,
} from '../../src/main/proxy/ollamaProtocol.ts'

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  let result = ''
  for await (const chunk of stream) result += chunk.toString()
  return result
}

test('OpenAI multimodal messages and tool calls translate to Ollama chat', () => {
  const result = openAIToOllamaChat({
    model: 'vision-model',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'describe' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    }],
    stream: false,
    temperature: 0.2,
  }, 'vision-model') as any

  assert.equal(result.messages[0].content, 'describe')
  assert.deepEqual(result.messages[0].images, ['AAAA'])
  assert.equal(result.options.temperature, 0.2)
})

test('Ollama response translates tool calls, thinking, and usage to OpenAI', () => {
  const result = ollamaChatToOpenAI({
    model: 'tool-model',
    message: {
      role: 'assistant',
      content: '',
      thinking: 'checking',
      tool_calls: [{ function: { name: 'weather', arguments: { city: 'Berlin' } } }],
    },
    prompt_eval_count: 4,
    eval_count: 2,
    done_reason: 'stop',
  }, 'fallback') as any

  assert.equal(result.choices[0].message.reasoning_content, 'checking')
  assert.equal(result.choices[0].message.tool_calls[0].function.name, 'weather')
  assert.equal(result.choices[0].finish_reason, 'tool_calls')
  assert.equal(result.usage.total_tokens, 6)
})

test('Claude and Ollama public route conversions preserve model and message content', () => {
  const claude = claudeRequestToOpenAI({
    model: 'm',
    system: 'system',
    messages: [{ role: 'user', content: 'hello' }],
  })
  assert.deepEqual(claude.messages.map(message => message.role), ['system', 'user'])

  const native = ollamaRequestToOpenAI({
    model: 'm',
    messages: [{ role: 'user', content: 'look', images: ['AAAA'] }],
  })
  assert.equal(Array.isArray(native.messages[0].content), true)

  const openAIResponse = {
    model: 'm',
    choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 2 },
  }
  assert.equal((openAIResponseToClaude(openAIResponse, 'm') as any).content[0].text, 'done')
  assert.equal((openAIResponseToOllama(openAIResponse, 'm') as any).message.content, 'done')
})

test('Claude tool_use and tool_result blocks translate to OpenAI tool messages', () => {
  const request = claudeRequestToOpenAI({
    model: 'tool-model',
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool-1', name: 'weather', input: { city: 'Berlin' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'sunny' }],
      },
    ],
  })

  assert.equal(request.messages[0].tool_calls?.[0].function.name, 'weather')
  assert.equal(request.messages[1].role, 'tool')
  assert.equal(request.messages[1].tool_call_id, 'tool-1')
  assert.equal(request.messages[1].content, 'sunny')
})

test('Claude Code requests: in-conversation system messages and adaptive thinking', () => {
  // Shape sent by Claude Code 2.1: environment as a trailing system message, adaptive thinking.
  const request = claudeRequestToOpenAI({
    model: 'm', system: [{ type: 'text', text: 'base' }], thinking: { type: 'adaptive', display: 'updates' },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }, { role: 'system', content: [{ type: 'text', text: '# Environment' }] }],
  })
  assert.deepEqual(request.messages.map(message => message.role), ['system', 'user'])
  assert.equal(request.messages[0].content, 'base\n\n# Environment')
  assert.equal(request.thinking, undefined, 'adaptive leaves thinking to the model')
  assert.deepEqual(claudeRequestToOpenAI({ model: 'm', thinking: { type: 'enabled', budget_tokens: 2048 }, messages: [{ role: 'user', content: 'x' }] }).thinking, { type: 'enabled', budget_tokens: 2048 })
  const noSystem = claudeRequestToOpenAI({ model: 'm', messages: [{ role: 'system', content: 'ctx' }, { role: 'user', content: 'x' }] })
  assert.deepEqual(noSystem.messages, [{ role: 'system', content: 'ctx' }, { role: 'user', content: 'x' }])
  assert.throws(() => claudeRequestToOpenAI({ model: 'm', messages: [{ role: 'system', content: [{ type: 'image' }] }, { role: 'user', content: 'x' }] }), /Invalid system content/)
})

test('Claude tool results come before text sent in the same user turn', () => {
  // Claude Code appends reminders after tool results; a user message must not split tool_calls from results.
  const request = claudeRequestToOpenAI({
    model: 'tool-model',
    messages: [
      { role: 'user', content: 'read both files' },
      { role: 'assistant', content: [
        { type: 'text', text: 'Reading.' },
        { type: 'tool_use', id: 'a', name: 'Read', input: { file_path: 'a.txt' } },
        { type: 'tool_use', id: 'b', name: 'Read', input: { file_path: 'b.txt' } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: 'A' }] },
        { type: 'tool_result', tool_use_id: 'b', content: 'B' },
        { type: 'text', text: '<system-reminder>keep going</system-reminder>' },
      ] },
    ],
  })
  assert.deepEqual(request.messages.map(message => message.role), ['user', 'assistant', 'tool', 'tool', 'user'])
  assert.deepEqual(request.messages.slice(2, 4).map(message => [message.tool_call_id, message.content]), [['a', 'A'], ['b', 'B']])
  assert.match(JSON.stringify(request.messages[4].content), /keep going/)
})

test('Ollama NDJSON and OpenAI SSE streams translate in both directions', async () => {
  const openAI = await collect(Readable.from([
    `${JSON.stringify({ model: 'm', message: { role: 'assistant', content: 'hi' }, done: false })}\n`,
    `${JSON.stringify({ model: 'm', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' })}\n`,
  ]).pipe(createOllamaNdjsonToOpenAIStream('m')))
  assert.match(openAI, /"content":"hi"/)
  assert.match(openAI, /data: \[DONE\]/)

  const ollama = await collect(Readable.from([
    `data: ${JSON.stringify({ model: 'm', choices: [{ delta: { role: 'assistant', content: 'hi' }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ model: 'm', choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n',
  ]).pipe(createOpenAISseToOllamaStream('m')))
  assert.match(ollama, /"content":"hi"/)
  assert.match(ollama, /"done":true/)
})

test('the final done event is recognised however the bytes are framed', async () => {
  const lines = [
    { model: 'm', message: { role: 'assistant', content: '', thinking: '想' }, done: false },
    { model: 'm', message: { role: 'assistant', content: '好的' }, done: false },
    { model: 'm', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', eval_count: 2 },
  ].map(line => JSON.stringify(line))
  const framings: Record<string, Buffer[]> = {
    'no trailing newline': [Buffer.from(lines.join('\n'))],
    'CRLF line endings': [Buffer.from(lines.join('\r\n') + '\r\n')],
    'one byte per chunk': Array.from(Buffer.from(lines.join('\n') + '\n'), byte => Buffer.from([byte])),
  }
  for (const [name, chunks] of Object.entries(framings)) {
    const output = await collect(Readable.from(chunks).pipe(createOllamaNdjsonToOpenAIStream('m')))
    assert.match(output, /"content":"好的"/, name)
    assert.match(output, /"finish_reason":"stop"/, name)
    assert.match(output, /data: \[DONE\]/, name)
  }
})

test('a truncated Ollama stream says how much arrived and whether any output was produced', async () => {
  const partial = `${JSON.stringify({ model: 'm', message: { role: 'assistant', content: 'hi' }, done: false })}\n`
  await assert.rejects(collect(Readable.from([partial]).pipe(createOllamaNdjsonToOpenAIStream('m'))),
    /ended before its done event \(1 event, \d+ bytes\); the node closed the response early/)
  await assert.rejects(collect(Readable.from([]).pipe(createOllamaNdjsonToOpenAIStream('m'))),
    /ended before its done event \(0 events, 0 bytes, no output\)/)
})
