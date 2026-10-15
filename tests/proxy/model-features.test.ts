import test from 'node:test'
import assert from 'node:assert/strict'
import { explicitThinking, normalizeModelFeatureDefaults, thinkingForModel } from '../../src/shared/modelFeatures.ts'
import { normalizeFeatureRequest, validateProviderFeatures, ollamaThinking, openAIThinkingFields } from '../../src/main/proxy/modelFeatures.ts'
import type { ChatCompletionRequest } from '../../src/main/proxy/types'
import type { Provider } from '../../src/main/store/types'
import { buildQwenAiConversation, resolveDeepSeekChatOptions } from '../../src/main/proxy/adapters/providerModelOptions.ts'

const request: ChatCompletionRequest = { model: 'qwen3-think', messages: [{ role: 'user', content: 'Hello' }] }
const provider = { id: 'local', name: 'Local', type: 'custom', upstreamKind: 'ollama', apiEndpoint: 'http://localhost:11434' } as Provider

test('explicit off wins over model aliases, effort and proxy defaults', () => {
  for (const setting of [{ enable_thinking: false }, { think: false }, { thinking: { type: 'disabled' as const } }, { reasoning_effort: 'none' as const }]) {
    const normalized = normalizeFeatureRequest({ ...request, ...setting }, { thinking: 'enabled' })
    assert.equal(explicitThinking(normalized), false)
    assert.equal(thinkingForModel(normalized), false)
  }
  assert.equal(thinkingForModel({ ...request, enable_thinking: false, reasoning_effort: 'high' }), false)
  assert.equal(thinkingForModel(request), true)
})

test('precedence is request body, extra body, header, proxy default, model default', () => {
  const defaults = { vision: 'disabled' as const, thinking: 'disabled' as const }
  const headers = { 'x-enable-thinking': 'true', 'x-enable-vision': 'true' }
  assert.equal(normalizeFeatureRequest(request, defaults, headers).enable_thinking, true)
  assert.equal(normalizeFeatureRequest({ ...request, enable_thinking: false }, defaults, headers).enable_thinking, false)
  assert.equal(normalizeFeatureRequest({ ...request, extra_body: { enable_thinking: false } }, defaults, headers).enable_thinking, false)
  assert.equal(normalizeFeatureRequest(request, defaults).enable_thinking, false)
  assert.equal(normalizeFeatureRequest(request).enable_thinking, undefined)
  assert.deepEqual(normalizeModelFeatureDefaults({ vision: 'wrong', thinking: 'enabled' }), { vision: 'auto', thinking: 'enabled' })
})

test('invalid body and string booleans fail at the boundary', () => {
  for (const bad of [null, [], { ...request, model: 123 }, { ...request, messages: [null] }, { ...request, stream: 'false' },
    { ...request, enable_thinking: 'false' }, { ...request, enable_vision: 'false' }, { ...request, think: 'false' },
    { ...request, reasoning_effort: 'off' }, { ...request, thinking: { type: 'wrong' } }, { ...request, extra_body: [] }]) {
    assert.throws(() => normalizeFeatureRequest(bad as any), { name: 'ModelFeatureError' })
  }
})

test('vision off removes images from every turn without mutating original messages', () => {
  const imageRequest = { ...request, messages: [
    { role: 'user' as const, content: [{ type: 'text' as const, text: 'First' }, { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,AAAA' } }] },
    { role: 'assistant' as const, content: 'Answer' },
    { role: 'user' as const, content: [{ type: 'text' as const, text: 'Next' }, { type: 'image_url' as const, image_url: { url: 'https://example.com/image.png' } }] },
  ] }
  const original = JSON.stringify(imageRequest)
  const output = normalizeFeatureRequest({ ...imageRequest, enable_vision: false })
  assert.ok(!JSON.stringify(output.messages).includes('image_url'))
  assert.equal(JSON.stringify(imageRequest), original)
  assert.deepEqual(normalizeFeatureRequest({ ...imageRequest, enable_vision: true }).messages, imageRequest.messages)
  assert.throws(() => normalizeFeatureRequest({ ...request, enable_vision: false, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'AAAA' } }] }] }), /no text/)
})

test('thinking is translated by transport, including GPT-OSS levels', () => {
  assert.equal(ollamaThinking({ think: 'high' }, 'gpt-oss:20b'), 'high')
  assert.equal(ollamaThinking({ enable_thinking: true }, 'gpt-oss:20b'), 'medium')
  assert.throws(() => ollamaThinking({ think: false }, 'gpt-oss:20b'), /requires thinking/)
  assert.equal(ollamaThinking({ reasoning_effort: 'none' }, 'qwen3'), false)
  assert.deepEqual(openAIThinkingFields({ enable_thinking: false }, 'qwen3', 'http://localhost', true), { reasoning_effort: 'none' })
  assert.deepEqual(openAIThinkingFields({ enable_thinking: false }, 'qwen-plus', 'https://dashscope.aliyuncs.com'), { enable_thinking: false })
  for (const host of ['https://api.deepseek.com', 'https://open.bigmodel.cn', 'https://api.z.ai', 'https://api.moonshot.ai']) {
    assert.deepEqual(openAIThinkingFields({ enable_thinking: false }, 'model', host), { thinking: { type: 'disabled' } })
  }
  assert.deepEqual(openAIThinkingFields({ enable_thinking: true }, 'MiniMax-M3', 'https://api.minimax.io'), { thinking: { type: 'adaptive' } })
  const custom = normalizeFeatureRequest({ ...request, extra_body: { chat_template_kwargs: { thinking: false } } })
  assert.deepEqual(openAIThinkingFields(custom, 'kimi-k2.5', 'http://local-vllm'), { chat_template_kwargs: { thinking: false } })
  assert.deepEqual(openAIThinkingFields({ ...custom, enable_thinking: true }, 'kimi-k2.5', 'http://local-vllm'), { chat_template_kwargs: { thinking: true } })
  assert.throws(() => normalizeFeatureRequest({ ...request, chat_template_kwargs: { thinking: 'false' } } as any), /must be a boolean/)
})

test('unsupported capabilities fail instead of silently ignoring the requested setting', () => {
  for (const model of ['gpt-oss:20b', 'GLM-5.3', 'glm-5.3-flash', 'MiniMax-M2.7', 'kimi-k2-thinking', 'qwen3-vl-thinking']) {
    assert.throws(() => validateProviderFeatures({ ...request, enable_thinking: false }, provider, model), /cannot disable/)
  }
  const imageRequest = { ...request, messages: [{ role: 'user' as const, content: [{ type: 'image_url' as const, image_url: { url: 'AAAA' } }] }] }
  assert.throws(() => validateProviderFeatures(imageRequest, { ...provider, type: 'builtin', upstreamKind: undefined, id: 'qwen-ai' }, 'qwen3'), /cannot forward image/)
  assert.doesNotThrow(() => validateProviderFeatures(imageRequest, provider, 'unknown-vision-model'))
})

test('DeepSeek native options and Qwen AI follow-up history preserve user intent', () => {
  assert.equal(resolveDeepSeekChatOptions({ model: 'deepseek-v4-pro-think', enable_thinking: false }).thinkingEnabled, false)
  assert.equal(resolveDeepSeekChatOptions({ model: 'deepseek-v4-pro-search', web_search: false }).searchEnabled, false)
  const result = buildQwenAiConversation([
    { role: 'system', content: 'Be helpful' },
    { role: 'user', content: [{ type: 'text', text: 'My name is Lin' }] },
    { role: 'assistant', content: 'Hello, Lin' },
    { role: 'user', content: 'What is my name?' },
  ])
  for (const text of ['Be helpful', 'My name is Lin', 'Hello, Lin', 'What is my name?']) assert.ok(result.includes(text))
  assert.ok(!result.includes('[object Object]'))
})
