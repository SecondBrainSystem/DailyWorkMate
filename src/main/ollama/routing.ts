import type { OllamaRoutingConfig } from '../../shared/types'
import { freeModelSource } from '../../shared/freeModels.ts'

export interface OllamaRoutingDecision {
  model: string
  ollamaOnly: boolean
  preferredProviderId?: string
  error?: string
}

export function resolveOllamaRouting(
  requestedModel: string,
  settings?: Partial<OllamaRoutingConfig>,
  useRequestedModel = false,
): OllamaRoutingDecision {
  // An explicit model chosen in AI Chat must not be replaced by API routing defaults.
  if (useRequestedModel) return { model: requestedModel, ollamaOnly: false }
  // Stored settings may come from an old backup; never let a malformed value break every chat.
  const text = (value: unknown) => typeof value === 'string' ? value.trim() : ''
  const forcedModel = settings?.forceModel ? text(settings.model) : ''
  // Free pools have their own transport and never require an Ollama node/account.
  const freeModel = forcedModel || (settings?.routeOriginalModel ? requestedModel : '')
  if (freeModel && freeModelSource(freeModel)) return { model: freeModel, ollamaOnly: false }
  const autoSelectUrl = Boolean(settings?.autoSelectUrl)
  const ollamaOnly = Boolean(forcedModel || settings?.routeOriginalModel)

  if (settings?.forceModel && !forcedModel) return { model: requestedModel, ollamaOnly: true, error: 'Select a model before enabling fixed Ollama routing' }
  if (ollamaOnly && !autoSelectUrl && !text(settings?.providerId)) {
    return { model: forcedModel || requestedModel, ollamaOnly: true, error: 'Select a fixed Ollama node or enable automatic node selection' }
  }

  return {
    model: forcedModel || requestedModel,
    ollamaOnly,
    preferredProviderId: ollamaOnly && !autoSelectUrl
      ? text(settings?.providerId) || undefined
      : undefined,
  }
}
