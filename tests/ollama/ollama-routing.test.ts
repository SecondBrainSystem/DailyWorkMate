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
