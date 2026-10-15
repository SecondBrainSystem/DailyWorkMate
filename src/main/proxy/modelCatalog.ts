import { loadBalancer } from './loadbalancer'
import { storeManager } from '../store/store'
import { modelMapper } from './modelMapper'
import type { ModelInfo } from './types'

/** Read the configured routing catalog without starting HTTP or probing a model. */
export function availableModelInfo(modelId: string): ModelInfo | undefined {
  const config = storeManager.getConfig()
  const preferredProviderId = modelMapper.getPreferredProvider(modelId)
  const provider = storeManager.getProviders().find(candidate =>
    candidate.enabled && (!preferredProviderId || candidate.id === preferredProviderId)
    && loadBalancer.getAvailableAccountCount(modelId, candidate.id, config.loadBalanceStrategy === 'failover') > 0)
  if (!provider) return undefined
  return {
    id: modelId, object: 'model', created: Math.floor(provider.createdAt / 1000),
    owned_by: config.modelMappings?.[modelId] ? 'model-mapping' : provider.name,
  }
}

export function listAvailableModels(): ModelInfo[] {
  const configured = storeManager.getProviders()
    .filter(provider => provider.enabled)
    .flatMap(provider => storeManager.getEffectiveModels(provider.id).map(model => model.displayName))
  const candidates = new Set([...configured, ...Object.keys(storeManager.getConfig().modelMappings || {})])
  return [...candidates].filter(id => !id.includes('*')).flatMap(id => {
    const model = availableModelInfo(id)
    return model ? [model] : []
  })
}
