import { storeManager } from '../store/store'
import { loadBalancer } from './loadbalancer'
import { modelMapper } from './modelMapper'
import type { AccountSelection } from './types'

export interface VerifiedModelResult {
  model: string
  previousModel?: string
  providerName: string
  verified: boolean
  skipped?: boolean
  recovered: boolean
  reason?: string
}

interface ModelRoutingFailure {
  success: false
  status: number
  error: string
  errorCode?: string
}

export async function verifyModelSelection(model: string, recover: boolean, signal?: AbortSignal): Promise<
  { success: true; value: VerifiedModelResult } | { success: false; result: ModelRoutingFailure }
> {
  if (signal?.aborted) return { success: false, result: { success: false, status: 499, error: 'Model verification cancelled' } }
  const config = storeManager.getConfig()
  const failure: ModelRoutingFailure = { success: false, status: 503, errorCode: 'model_unavailable', error: `没有可用节点支持模型 ${model}。` }
  const value = (selected: AccountSelection, selectedModel: string): VerifiedModelResult => ({
    model: selectedModel, providerName: selected.provider.name, verified: false, skipped: true,
    recovered: selectedModel !== model,
    ...(selectedModel !== model ? { previousModel: model, reason: failure.error } : {}),
  })

  // Routing eligibility is a read-only check; it never runs an inference challenge.
  const selection = loadBalancer.selectAccount(model, config.loadBalanceStrategy,
    modelMapper.getPreferredProvider(model), modelMapper.getPreferredAccount(model), undefined, [], false)
  if (selection) return { success: true, value: value(selection, model) }
  if (!recover) return { success: false, result: failure }

  // Recovery is an explicit UI operation. Never change the model in a completion request,
  // and never spend tokens probing unrelated authenticated commercial providers.
  for (const provider of storeManager.getProviders().filter(provider => provider.enabled && provider.upstreamKind === 'ollama')) {
    for (const candidate of storeManager.getEffectiveModels(provider.id)) {
      const fallback = loadBalancer.selectAccount(candidate.displayName, config.loadBalanceStrategy, provider.id, undefined, 'ollama', [], false)
      if (fallback) return { success: true, value: value(fallback, candidate.displayName) }
    }
  }
  return { success: false, result: failure }
}
