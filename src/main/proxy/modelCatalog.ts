import { createRoutingSnapshot, loadBalancer, type RoutingSnapshot } from './loadbalancer'
import { modelMapper } from './modelMapper'
import type { ModelInfo } from './types'

/** Read the configured routing catalog without starting HTTP or probing a model. */
export function availableModelInfo(modelId: string, snapshot: RoutingSnapshot = createRoutingSnapshot()): ModelInfo | undefined {
  const { config } = snapshot
  const preferredProviderId = modelMapper.getPreferredProvider(modelId)
  const provider = snapshot.providers.find(candidate =>
    candidate.enabled && (!preferredProviderId || candidate.id === preferredProviderId)
    && loadBalancer.getAvailableAccountCount(modelId, candidate.id, config.loadBalanceStrategy === 'failover', snapshot) > 0)
  if (!provider) return undefined
  return {
    id: modelId, object: 'model', created: Math.floor(provider.createdAt / 1000),
    owned_by: config.modelMappings?.[modelId] ? 'model-mapping' : provider.name,
  }
}

export function listAvailableModels(): ModelInfo[] {
  // One snapshot for the whole catalog: each provider's models and accounts are read once.
  const snapshot = createRoutingSnapshot()
  const configured = snapshot.providers
    .filter(provider => provider.enabled)
    .flatMap(provider => snapshot.models(provider.id).map(model => model.displayName))
  const candidates = new Set([...configured, ...Object.keys(snapshot.config.modelMappings || {})])
  return [...candidates].filter(id => !id.includes('*')).flatMap(id => {
    const model = availableModelInfo(id, snapshot)
    return model ? [model] : []
  })
}
