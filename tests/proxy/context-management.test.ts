import test from 'node:test'
import assert from 'node:assert/strict'
import { SlidingWindowStrategy, TokenLimitStrategy, SummaryStrategy, ContextManagementService } from '../../src/main/proxy/services/contextManagementService.ts'
import type { ChatMessage } from '../../src/main/proxy/types'

const messages: ChatMessage[] = [
  { role: 'system', content: 'Follow these instructions.' },
  { role: 'user', content: 'Earlier question' },
  { role: 'assistant', content: 'Earlier answer' },
  { role: 'assistant', content: null, reasoning_content: 'Check both cities', tool_calls: ['a', 'b'].map(id => ({
    id, type: 'function', function: { name: 'weather', arguments: JSON.stringify({ city: id.repeat(200) }) },
  })) },
  { role: 'tool', tool_call_id: 'a', content: 'sunny' },
  { role: 'tool', tool_call_id: 'b', content: 'rain' },
]

test('sliding and token windows keep complete parallel tool exchanges without mutating input', () => {
  const original = structuredClone(messages)
  for (const strategy of [new SlidingWindowStrategy({ enabled: true, maxMessages: 2 }), new TokenLimitStrategy({ enabled: true, maxTokens: 12 })]) {
    assert.deepEqual(strategy.execute(messages).messages, [messages[0], ...messages.slice(3)])
  }
  assert.deepEqual(messages, original)
  assert.ok(ContextManagementService.estimateTotalTokens(messages) > 160, 'tool arguments count towards the budget')
})

test('system messages exhausting the budget never discard the latest user message or retain the whole history', () => {
  const input: ChatMessage[] = [{ role: 'system', content: 'x'.repeat(300) }, { role: 'user', content: 'old' }, { role: 'user', content: 'latest' }]
  for (const strategy of [new SlidingWindowStrategy({ enabled: true, maxMessages: 1 }), new TokenLimitStrategy({ enabled: true, maxTokens: 1 })]) {
    assert.deepEqual(strategy.execute(input).messages, [input[0], input[2]])
  }
})

test('summary boundaries and fallback preserve system instructions and complete tool history', async () => {
  let summarized: ChatMessage[] = []
  const strategy = new SummaryStrategy({ enabled: true, keepRecentMessages: 1 }, async history => { summarized = history; return 'Summary' })
  const result = await strategy.execute(messages)
  assert.deepEqual(summarized, messages.slice(1, 3))
  assert.deepEqual(result.messages, [messages[0], { role: 'system', content: '[Conversation Summary]\nSummary' }, ...messages.slice(3)])
  assert.deepEqual((await new SummaryStrategy({ enabled: true, keepRecentMessages: 1 }).execute(messages)).messages, [messages[0], ...messages.slice(3)])
})
