import deepseekConfig from './deepseek.ts'
import glmConfig from './glm.ts'
import kimiConfig from './kimi.ts'
import minimaxConfig from './minimax.ts'
import mimoConfig from './mimo.ts'
import perplexityConfig from './perplexity.ts'
import qwenConfig from './qwen.ts'
import qwenAiConfig from './qwen-ai.ts'
import zaiConfig from './zai.ts'
import type { BuiltinProviderConfig, Provider } from '../../store/types.ts'

export const builtinProviders: BuiltinProviderConfig[] = [
  deepseekConfig,
  glmConfig,
  kimiConfig,
  minimaxConfig,
  mimoConfig,
  perplexityConfig,
  qwenConfig,
  qwenAiConfig,
  zaiConfig,
]

export const builtinProviderMap: Record<string, BuiltinProviderConfig> = {
  deepseek: deepseekConfig,
  glm: glmConfig,
  kimi: kimiConfig,
  minimax: minimaxConfig,
  mimo: mimoConfig,
  perplexity: perplexityConfig,
  qwen: qwenConfig,
  'qwen-ai': qwenAiConfig,
  zai: zaiConfig,
}

export function getBuiltinProvider(id: string): BuiltinProviderConfig | undefined {
  return builtinProviderMap[id]
}

export function getBuiltinProviders(): BuiltinProviderConfig[] {
  return builtinProviders
}

/** A fresh stored provider for a builtin definition. The single builtin -> Provider conversion. */
export function providerFromBuiltin(builtin: BuiltinProviderConfig, now = Date.now()): Provider {
  return { ...structuredClone(builtin), enabled: true, createdAt: now, updatedAt: now }
}

const uniqueModels = (models: readonly string[]): string[] => [...new Set(models)]

/**
 * Refresh the definition-owned fields of a stored builtin provider while keeping user state.
 * A model list the user refreshed from the upstream is kept, but models added or renamed in the
 * builtin definition are merged in so app updates still reach users who refreshed once.
 */
export function refreshBuiltinProvider(stored: Provider, builtin: BuiltinProviderConfig, resetModels = false): Provider {
  const definition = structuredClone(builtin)
  const keepFetched = Boolean(stored.modelsUpdatedAt) && !resetModels
  return {
    ...stored,
    apiEndpoint: definition.apiEndpoint,
    chatPath: definition.chatPath,
    modelsApiEndpoint: definition.modelsApiEndpoint,
    headers: definition.headers,
    credentialFields: definition.credentialFields,
    description: definition.description,
    supportedModels: keepFetched
      ? uniqueModels([...(stored.supportedModels || []), ...(definition.supportedModels || [])])
      : definition.supportedModels,
    modelMappings: keepFetched
      ? { ...(definition.modelMappings || {}), ...(stored.modelMappings || {}) }
      : definition.modelMappings,
  } as Provider
}

export {
  deepseekConfig,
  glmConfig,
  kimiConfig,
  minimaxConfig,
  mimoConfig,
  perplexityConfig,
  qwenConfig,
  qwenAiConfig,
  zaiConfig,
}

export default builtinProviders
