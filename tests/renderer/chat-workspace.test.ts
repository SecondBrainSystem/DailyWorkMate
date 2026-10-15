import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { normalizeChatWorkspace } from '../../src/renderer/src/lib/chatWorkspace.ts'

test('chat history retains the actual answer model and retry source without guessing legacy models', () => {
  const messages = [
    { id: 'old', role: 'assistant', content: 'legacy' },
    { id: 'refusal', role: 'assistant', content: 'refused', model: 'minimax-m3:cloud' },
    { id: 'retry', role: 'assistant', content: 'read completed', model: 'opencode/ling-3.1-flash-free', retryOf: 'refusal' },
  ]
  const restored = normalizeChatWorkspace(JSON.parse(JSON.stringify({ model: 'current-picker-model', messages })))
  assert.deepEqual(restored.messages, messages)
  assert.equal(restored.messages[0].model, undefined)
})

test('chat history drops malformed attribution and user-supplied answer metadata', () => {
  const restored = normalizeChatWorkspace({ messages: [
    { id: 'bad', role: 'assistant', content: 'answer', model: 'bad\nmodel', retryOf: 'x'.repeat(81) },
    { id: 'user', role: 'user', content: 'question', model: 'claimed', retryOf: 'source' },
  ] })
  assert.deepEqual(restored.messages, [
    { id: 'bad', role: 'assistant', content: 'answer' },
    { id: 'user', role: 'user', content: 'question' },
  ])
})

import {
  createProxyHeaders,
  readChatCompletionStream,
  resolveLocalProxyBaseUrl,
} from '../../src/renderer/src/lib/chatClient.ts'

test('chat resolves wildcard bind addresses to a reachable loopback URL', () => {
  assert.equal(resolveLocalProxyBaseUrl({ proxyHost: '0.0.0.0', proxyPort: 11434 }), 'http://127.0.0.1:11434')
  assert.equal(resolveLocalProxyBaseUrl({ proxyHost: '::1', proxyPort: 8080 }), 'http://[::1]:8080')
})

test('chat authenticates to an API-key protected local proxy', () => {
  assert.deepEqual(createProxyHeaders({
    enableApiKey: true,
    apiKeys: [
      { id: 'off', name: 'off', key: 'ignored', enabled: false, createdAt: 0, usageCount: 0 },
      { id: 'on', name: 'on', key: 'secret', enabled: true, createdAt: 0, usageCount: 0 },
    ],
  }), {
    'Content-Type': 'application/json',
    Authorization: 'Bearer secret',
  })
})

test('chat parses content and reasoning from fragmented SSE chunks', async () => {
  const encoder = new TextEncoder()
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n'))
      controller.enqueue(encoder.encode('\ndata: {"choices":[{"delta":{"content":"hel'))
      controller.enqueue(encoder.encode('lo"}}]}\n\ndata: [DONE]\n\n'))
      controller.close()
    },
  }), { status: 200 })
  const received: Array<{ content?: string; reasoning?: string }> = []

  await readChatCompletionStream(response, delta => received.push(delta))

  assert.deepEqual(received, [{ reasoning: 'think' }, { content: 'hello' }])
})

test('chat route, navigation, attachments and built-in tasks are wired', () => {
  const app = readFileSync('src/renderer/src/App.tsx', 'utf8')
  const sidebar = readFileSync('src/renderer/src/components/layout/navigation.ts', 'utf8')
  const page = readFileSync('src/renderer/src/pages/Chat.tsx', 'utf8')
  const prompts = readFileSync('src/renderer/src/lib/chatPrompts.ts', 'utf8')

  assert.match(app, /path="\/chat"/)
  assert.match(sidebar, /href: '\/chat'/)
  assert.match(page, /\/v1\/chat\/completions/)
  assert.match(page, /readAsText/)
  assert.match(prompts, /chat-translate/)
  assert.match(prompts, /chat-summary/)
})

test('chat persists sessions and exposes prompt editing and response retry controls', () => {
  const page = readFileSync('src/renderer/src/pages/Chat.tsx', 'utf8')
  const builtins = readFileSync('src/main/data/builtin-prompts.ts', 'utf8')
  const store = readFileSync('src/main/store/store.ts', 'utf8')
  const workspace = readFileSync('src/renderer/src/lib/chatWorkspace.ts', 'utf8')

  assert.match(workspace, /CHAT_STORAGE_KEY/)
  assert.match(workspace, /storage\.setItem/)
  assert.match(page, /prompts\.update/)
  assert.match(page, /regenerateLastResponse/)
  assert.match(page, /editAndResend/)
  assert.match(builtins, /chat-translate/)
  assert.match(builtins, /chat-actions/)
  assert.match(store, /Built-in prompt edits are stored as user overrides/)
})

test('the proxy toggle does not inherit the global dashboard loading state', () => {
  const dashboard = readFileSync('src/renderer/src/pages/Dashboard.tsx', 'utf8')
  const header = readFileSync('src/renderer/src/components/layout/Header.tsx', 'utf8')

  // The top bar owns the only proxy switch; the dashboard no longer repeats it.
  assert.doesNotMatch(dashboard, /proxy\.(start|stop)\(/)
  assert.match(header, /disabled=\{proxyLoading\}/)
  assert.doesNotMatch(header, /useDashboardStore/)
})
