import test from 'node:test'
import assert from 'node:assert/strict'
import { builtinProviders, deepseekConfig, providerFromBuiltin, refreshBuiltinProvider } from '../../src/main/providers/builtin/index.ts'
import { BUILTIN_PROVIDERS, DEEPSEEK_PRIMARY_MODELS } from '../../src/main/store/types.ts'
import type { Provider } from '../../src/main/store/types.ts'

test('builtin providers have a single source of truth', () => {
  assert.equal(BUILTIN_PROVIDERS, builtinProviders)
  assert.deepEqual([...DEEPSEEK_PRIMARY_MODELS], deepseekConfig.supportedModels)
})

test('one conversion creates stored builtin providers without sharing definition objects', () => {
  const provider = providerFromBuiltin(deepseekConfig, 42)
  assert.equal(provider.createdAt, 42)
  assert.equal(provider.enabled, true)
  assert.deepEqual(provider.credentialFields, deepseekConfig.credentialFields)
  provider.supportedModels?.push('mutated')
  assert.ok(!deepseekConfig.supportedModels?.includes('mutated'))
})

test('a refreshed model list keeps upstream models and still receives builtin additions and renames', () => {
  const stored: Provider = { ...providerFromBuiltin(deepseekConfig, 1), supportedModels: ['upstream-only', 'deepseek-old-name'], modelMappings: { 'upstream-only': 'u' }, modelsUpdatedAt: 5, enabled: false }
  const refreshed = refreshBuiltinProvider(stored, deepseekConfig)
  assert.deepEqual(refreshed.supportedModels, ['upstream-only', 'deepseek-old-name', ...(deepseekConfig.supportedModels || [])])
  assert.equal(refreshed.modelMappings?.['upstream-only'], 'u')
  assert.equal(refreshed.modelMappings?.[deepseekConfig.supportedModels![0]], deepseekConfig.modelMappings?.[deepseekConfig.supportedModels![0]])
  assert.equal(refreshed.enabled, false, 'user state survives')
  assert.deepEqual(refreshBuiltinProvider(stored, deepseekConfig, true).supportedModels, deepseekConfig.supportedModels)
  const neverRefreshed = refreshBuiltinProvider({ ...stored, modelsUpdatedAt: undefined }, deepseekConfig)
  assert.deepEqual(neverRefreshed.supportedModels, deepseekConfig.supportedModels)
})
