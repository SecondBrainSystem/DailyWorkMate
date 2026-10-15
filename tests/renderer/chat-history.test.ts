import test from 'node:test'
import assert from 'node:assert/strict'
import { createConversation, conversationSummary, updateHistorySummaries } from '../../src/renderer/src/lib/chatHistory.ts'
import { normalizeChatWorkspace, type PersistedChatState } from '../../src/renderer/src/lib/chatWorkspace.ts'

const blank: PersistedChatState = { messages: [], model: 'qwen3:8b', promptId: '', vision: 'auto', thinking: 'auto' }

test('history preserves more than 100 messages, images, drafts and per-conversation settings', () => {
  const image = { id: 'image', name: 'image.png', mimeType: 'image/png', size: 8, kind: 'image' as const, content: 'data:image/png;base64,YWJj' }
  const state: PersistedChatState = {
    ...blank, conversationId: 'original', createdAt: 10, savedAt: 20,
    messages: Array.from({ length: 120 }, (_, index) => ({ id: String(index), role: index % 2 ? 'assistant' : 'user', content: `Message ${index}`, ...(index === 0 ? { attachments: [image] } : {}) })),
    draft: 'Continue here', draftAttachments: [image], thinking: 'disabled', vision: 'enabled', promptId: 'task', systemPrompt: 'Original task text',
  }
  const original = structuredClone(state)
  const restored = createConversation(state, 30)
  assert.deepEqual(restored, { ...original, savedAt: 30 })
  assert.deepEqual(state, original)
  assert.equal(conversationSummary(restored)?.messageCount, 120)
})

test('blank chats stay out of history while draft-only and image-only chats get titles', () => {
  assert.equal(conversationSummary(createConversation(blank)), undefined)
  assert.equal(conversationSummary(createConversation({ ...blank, draft: '  Draft\n title ' }))?.title, 'Draft title')
  const state = createConversation({ ...blank, messages: [{ id: '1', role: 'user', content: '', attachments: [{ id: 'image', name: 'photo.png', mimeType: 'image/png', size: 4, kind: 'image', content: 'data:image/png;base64,YWJj' }] }] })
  assert.equal(conversationSummary(state)?.title, 'photo.png')
})

test('history summaries update immutably, deduplicate, reorder and remove emptied entries', () => {
  const a = createConversation({ ...blank, conversationId: 'a', draft: 'First' }, 10)
  const b = createConversation({ ...blank, conversationId: 'b', draft: 'Second' }, 20)
  const items = updateHistorySummaries(updateHistorySummaries([], a), b)
  const snapshot = structuredClone(items)
  const updated = updateHistorySummaries(items, createConversation({ ...a, draft: 'Edited' }, 30))
  assert.deepEqual(updated.map(item => item.id), ['a', 'b'])
  assert.equal(updated[0].title, 'Edited')
  assert.deepEqual(items, snapshot)
  assert.deepEqual(updateHistorySummaries(updated, { ...a, draft: '' }).map(item => item.id), ['b'])
})

test('legacy normalization validates draft attachments and interrupted assistant responses', () => {
  const state = normalizeChatWorkspace({ ...blank, draft: 'Retained', draftAttachments: [null, { kind: 'image', content: 'javascript:alert(1)' }], messages: [{ id: '1', role: 'assistant', content: '' }, { id: '2', role: 'assistant', content: '', reasoning: 'Partial reasoning' }] })
  assert.deepEqual(state.draftAttachments, [])
  assert.deepEqual(state.messages, [{ id: '2', role: 'assistant', content: '', reasoning: 'Partial reasoning' }])
})
