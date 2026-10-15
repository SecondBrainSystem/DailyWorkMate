import test from 'node:test'
import assert from 'node:assert/strict'
import { toChatApiMessages } from '../../src/renderer/src/lib/chatRequest.ts'
import { normalizeChatWorkspace, type ChatMessage } from '../../src/renderer/src/lib/chatWorkspace.ts'

test('failed and stopped empty messages remain visible after restore without entering context', () => {
  const messages: ChatMessage[] = [
    { id: 'u1', role: 'user', content: 'question' },
    { id: 'failed', role: 'assistant', content: '', status: 'error' },
    { id: 'stopped', role: 'assistant', content: '', status: 'stopped' },
    { id: 'pending', role: 'assistant', content: '' },
    { id: 'thinking', role: 'assistant', content: '', reasoning: 'incomplete thought', status: 'stopped' },
    { id: 'u2', role: 'user', content: 'try again' },
  ]
  const restored = normalizeChatWorkspace(JSON.parse(JSON.stringify({ messages })))
  assert.deepEqual(restored.messages.map(m => m.id), ['u1','failed','stopped','thinking','u2'])
  assert.equal(restored.messages[1].status, 'error')
  assert.equal(restored.messages[2].status, 'stopped')
  assert.deepEqual(toChatApiMessages(restored.messages, true), [
    { role: 'user', content: 'question' }, { role: 'user', content: 'try again' },
  ])
})

test('actual partial output stays in context when generation was interrupted', () => {
  const messages: ChatMessage[] = [
    { id: 'a1', role: 'assistant', content: 'Partial answer', status: 'error' },
    { id: 'a2', role: 'assistant', content: 'Stopped answer', status: 'stopped' },
  ]
  const before = structuredClone(messages)
  assert.deepEqual(toChatApiMessages(messages, true), [
    { role: 'assistant', content: 'Partial answer' }, { role: 'assistant', content: 'Stopped answer' },
  ])
  assert.deepEqual(messages, before)
})

test('context preserves text attachments and controls image inclusion', () => {
  const messages: ChatMessage[] = [{
    id: 'u', role: 'user', content: 'Summarize', attachments: [
      { id: 'file', name: 'data.txt', size: 5, mimeType: 'text/plain', kind: 'text', content: 'hello' },
      { id: 'image', name: 'image.png', size: 1, mimeType: 'image/png', kind: 'image', content: 'data:image/png;base64,AA==' },
    ],
  }]
  const text = 'Summarize\n\n<attachment name="data.txt">\nhello\n</attachment>'
  assert.deepEqual(toChatApiMessages(messages, false), [{ role: 'user', content: text }])
  assert.deepEqual(toChatApiMessages(messages, true), [{ role: 'user', content: [
    { type: 'text', text },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==', detail: 'auto' } },
  ] }])
})
