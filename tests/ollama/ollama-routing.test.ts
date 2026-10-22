import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveOllamaRouting } from '../../src/main/ollama/routing.ts'

test('keeps normal routing when Ollama overrides are disabled', () => {
  assert.deepEqual(resolveOllamaRouting('client-model', {
    forceModel: false,
    model: 'configured-model',
    autoSelectUrl: false,
    providerId: 'node-1',
  }), {
    model: 'client-model',
    ollamaOnly: false,
    preferredProviderId: undefined,
  })
})

test('forces the configured model and fixed Ollama node', () => {
  assert.deepEqual(resolveOllamaRouting('anything', {
    forceModel: true,
    model: 'qwen3:8b',
    autoSelectUrl: false,
    providerId: 'node-1',
  }), {
    model: 'qwen3:8b',
    ollamaOnly: true,
    preferredProviderId: 'node-1',
  })
})

test('automatic URL mode allows load balancing across Ollama nodes', () => {
  assert.deepEqual(resolveOllamaRouting('anything', {
    forceModel: true,
    model: 'qwen3:8b',
    autoSelectUrl: true,
    providerId: 'node-1',
  }), {
    model: 'qwen3:8b',
    ollamaOnly: true,
    preferredProviderId: undefined,
  })
})

test('forced free models need no node and ignore old node pins in either URL mode', () => {
  for (const model of ['opencode-free/test-free', 'kilo-free/test/free']) {
    for (const providerId of ['', 'old-node']) for (const autoSelectUrl of [false, true]) {
      assert.deepEqual(resolveOllamaRouting('client-model', { forceModel: true, model, providerId, autoSelectUrl }), { model, ollamaOnly: false })
    }
    assert.deepEqual(resolveOllamaRouting('desktop-selection', { forceModel: true, model }, true), { model: 'desktop-selection', ollamaOnly: false })
  }
  assert.ok(resolveOllamaRouting('client-model', { forceModel: true, model: '' }).error)
  assert.ok(resolveOllamaRouting('client-model', { forceModel: true, model: 'qwen3:8b', providerId: '' }).error)
})

test('original-model routing selects fixed or automatic nodes without using the saved forced model', () => {
  for (const autoSelectUrl of [false, true]) {
    assert.deepEqual(resolveOllamaRouting('client-model', {
      forceModel: false, routeOriginalModel: true, model: 'old-forced-model', providerId: 'node-1', autoSelectUrl,
    }), { model: 'client-model', ollamaOnly: true, preferredProviderId: autoSelectUrl ? undefined : 'node-1' })
  }
  assert.ok(resolveOllamaRouting('client-model', { routeOriginalModel: true, providerId: '' }).error)
  assert.deepEqual(resolveOllamaRouting('chat-model', { routeOriginalModel: true, providerId: 'node-1' }, true), { model: 'chat-model', ollamaOnly: false })
  for (const model of ['kilo-free/test/free', 'opencode-free/test-free']) {
    assert.deepEqual(resolveOllamaRouting(model, { routeOriginalModel: true, model: 'old-forced-model' }), { model, ollamaOnly: false })
  }
})
