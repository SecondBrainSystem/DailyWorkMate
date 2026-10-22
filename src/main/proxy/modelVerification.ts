import { storeManager } from '../store/store'
import { loadBalancer } from './loadbalancer'
import { modelMapper } from './modelMapper'
import type { AccountSelection } from './types'
import { freeModelSource } from '../../shared/freeModels'
import { KiloModelError } from '../inference/kiloModels'
import { OpenCodeModelError } from '../companion/opencodeModels'
import { resolveProxyFreeModel } from '../inference/modelListing'

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
  const source = freeModelSource(model)
  if (source) {
    try {
      await resolveProxyFreeModel(model, signal)
      if (signal?.aborted) return { success: false, result: { success: false, status: 499, error: 'Model verification cancelled' } }
      return { success: true, value: { model, providerName: source.name, verified: false, skipped: true, recovered: false } }
    } catch (error) {
      if (signal?.aborted) return { success: false, result: { success: false, status: 499, error: 'Model verification cancelled' } }
      return { success: false, result: { success: false, status: error instanceof KiloModelError || error instanceof OpenCodeModelError ? error.status : 503,
        error: error instanceof Error ? error.message : `${source.name} catalogue unavailable`, errorCode: 'free_model_unavailable' } }
    }
  }
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
