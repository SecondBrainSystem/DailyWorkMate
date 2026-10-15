import type { OllamaRoutingConfig } from '../../shared/types'

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
  const forcedModel = settings?.forceModel ? settings.model?.trim() : ''
  const autoSelectUrl = Boolean(settings?.autoSelectUrl)
  const ollamaOnly = Boolean(forcedModel)

  if (settings?.forceModel && !forcedModel) return { model: requestedModel, ollamaOnly: true, error: 'Select a model before enabling fixed Ollama routing' }
  if (forcedModel && !autoSelectUrl && !settings?.providerId?.trim()) {
    return { model: forcedModel, ollamaOnly: true, error: 'Select a fixed Ollama node or enable automatic node selection' }
  }

  return {
    model: forcedModel || requestedModel,
    ollamaOnly,
    preferredProviderId: ollamaOnly && !autoSelectUrl
      ? settings?.providerId?.trim() || undefined
      : undefined,
  }
}
