import test from 'node:test'
import assert from 'node:assert/strict'
import { CHAT_STORAGE_KEY, loadPersistedChatState, persistChatState } from '../../src/renderer/src/lib/chatWorkspace.ts'
import { createProxyHeaders, readChatCompletionStream } from '../../src/renderer/src/lib/chatClient.ts'

test('clear persists immediately and cannot restore previous history', () => {
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
  const state = { messages: [{ id: '1', role: 'user' as const, content: 'Old conversation' }], model: 'qwen3', promptId: 'prompt', vision: 'disabled' as const, thinking: 'enabled' as const }
  assert.equal(persistChatState(state, storage), true)
  assert.equal(loadPersistedChatState(storage).messages.length, 1)
  assert.equal(persistChatState({ ...state, messages: [] }, storage), true)
  assert.deepEqual(loadPersistedChatState(storage), { ...state, messages: [] })
})

test('corrupt history and attachment metadata cannot crash restored chat', () => {
  const state = loadPersistedChatState({ getItem: () => JSON.stringify({ messages: [null, { id: 'a', role: 'user', content: 'hi', attachments: [null, {}, { kind: 'image', content: 'javascript:alert(1)' }] }, { id: 'b', role: 'assistant', content: '' }] }) })
  assert.deepEqual(state.messages, [{ id: 'a', role: 'user', content: 'hi', attachments: [] }])
  assert.deepEqual(loadPersistedChatState({ getItem: () => 'null' }).messages, [])
})

test('failed replies retain their specific error and partial content across reloads', () => {
  const message = {id:'failed',role:'assistant',content:'部分译文',status:'error',error:'HTTP 504: node timed out'}
  const restored = loadPersistedChatState({getItem:() => JSON.stringify({messages:[message]})})
  assert.deepEqual(restored.messages, [message])
})

test('workspace failures and confirmed tools survive history normalization without text', () => {
  const failure = { id: 'work-error', role: 'assistant', content: '', error: 'OpenCode V2 model request failed', toolStatus: 'none' }
  const tools = { id: 'work-tools', role: 'assistant', content: '', toolStatus: 'used', tools: [
    { id: 'read-1', name: 'read', status: 'completed', title: 'data/notes.txt' },
  ] }
  const restored = loadPersistedChatState({ getItem: () => JSON.stringify({ messages: [failure, tools] }) })
  assert.deepEqual(restored.messages, [failure, tools])
})

test('quota failure removes stale history without silently dropping attachments', () => {
  let removed = ''
  const saved = persistChatState({ messages: [], model: '', promptId: '', vision: 'auto', thinking: 'auto' }, {
    setItem: () => { throw new Error('QuotaExceededError') }, removeItem: key => { removed = key },
  })
  assert.equal(saved, false)
  assert.equal(removed, CHAT_STORAGE_KEY)
})

test('SSE DONE releases the reader even when the server keeps the connection open', async () => {
  let cancelled = false
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')) }, cancel() { cancelled = true } }))
  await readChatCompletionStream(response, () => {})
  assert.equal(cancelled, true)
  assert.equal(response.body?.locked, false)
})

test('SSE handles final lines and detects truncated responses', async () => {
  const deltas: unknown[] = []
  await readChatCompletionStream(new Response('data: {"choices":[{"delta":{"content":"完整"},"finish_reason":"stop"}]}'), delta => deltas.push(delta))
  assert.deepEqual(deltas, [{ content: '完整' }])
  const response = new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')
  await assert.rejects(readChatCompletionStream(response, () => {}), /before completion/)
  assert.equal(response.body?.locked, false)
})

test('missing API keys fail clearly when authentication is on', () => {
  assert.throws(() => createProxyHeaders({ enableApiKey: true, apiKeys: [] }), /no enabled API key/)
})
