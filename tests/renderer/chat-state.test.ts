import test from 'node:test'
import assert from 'node:assert/strict'
import { CHAT_STORAGE_KEY, chatStateBackup, loadPersistedChatState, persistChatState, restoreOmittedImages } from '../../src/renderer/src/lib/chatWorkspace.ts'
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

test('a backup that cannot be written keeps the previous good copy', () => {
  const values = new Map([[CHAT_STORAGE_KEY, '{"messages":[{"id":"old","role":"user","content":"kept"}]}']])
  const saved = persistChatState({ messages: [], model: '', promptId: '', vision: 'auto', thinking: 'auto' }, {
    setItem: () => { throw new Error('QuotaExceededError') },
  })
  assert.equal(saved, false)
  assert.equal(loadPersistedChatState({ getItem: key => values.get(key) ?? null }).messages[0].content, 'kept')
  const oversized = persistChatState({ messages: [{ id: 'big', role: 'user', content: 'x'.repeat(3_000_001) }], model: '', promptId: '', vision: 'auto', thinking: 'auto' }, {
    setItem: (key, value) => { values.set(key, value) },
  })
  assert.equal(oversized, false)
  assert.equal(loadPersistedChatState({ getItem: key => values.get(key) ?? null }).messages[0].content, 'kept')
})

const image = (id: string) => ({ id, name: id + '.png', mimeType: 'image/png', size: 4, kind: 'image' as const, content: 'data:image/png;base64,AAAA' })
const text = (id: string) => ({ id, name: id + '.txt', mimeType: 'text/plain', size: 2, kind: 'text' as const, content: 'hi' })

test('the synchronous backup leaves out image data and records the omitted ids', () => {
  const values = new Map<string, string>()
  const state = { messages: [{ id: 'u', role: 'user' as const, content: 'see', attachments: [image('a'), text('t')] }], draftAttachments: [image('d')], model: 'm', promptId: '', vision: 'auto' as const, thinking: 'auto' as const }
  assert.equal(persistChatState(state, { setItem: (key, value) => { values.set(key, value) } }), true)
  assert.doesNotMatch(values.get(CHAT_STORAGE_KEY)!, /base64/)
  const restored = loadPersistedChatState({ getItem: key => values.get(key) ?? null })
  assert.deepEqual(restored.messages[0].attachments, [text('t')])
  assert.deepEqual(restored.draftAttachments, [])
  assert.deepEqual(restored.omittedImageIds, ['a', 'd'])
  assert.equal(state.messages[0].attachments.length, 2, 'the live state is not mutated')
  assert.equal(chatStateBackup({ ...state, messages: [], draftAttachments: [] }).omittedImageIds, undefined)
})

test('recovering a backup restores omitted images from history in their original order', () => {
  const full = { messages: [{ id: 'u', role: 'user' as const, content: 'see', attachments: [image('a'), text('t')] }], draftAttachments: [image('d')], model: 'm', promptId: '', vision: 'auto' as const, thinking: 'auto' as const }
  const backup = { ...chatStateBackup(full), messages: [...chatStateBackup(full).messages, { id: 'new', role: 'user' as const, content: 'later' }] }
  const restored = restoreOmittedImages(backup, full)
  assert.deepEqual(restored.messages[0].attachments, [image('a'), text('t')])
  assert.deepEqual(restored.draftAttachments, [image('d')])
  assert.equal(restored.messages[1].content, 'later')
  assert.equal('omittedImageIds' in restored, false)
  const lost = restoreOmittedImages(backup, undefined)
  assert.deepEqual(lost.messages[0].attachments, [text('t')])
  assert.equal('omittedImageIds' in lost, false)
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
