/** Namespaced IDs prevent free pools from shadowing configured models. */
export const KILO_FREE_PREFIX = 'kilo-free/'
export function isKiloFreeModel(model: string): boolean { return model.startsWith(KILO_FREE_PREFIX) }
export const OPENCODE_FREE_MODEL_PREFIX = 'opencode-free/'
export function isOpenCodeFreeModel(model: string): boolean { return model.startsWith(OPENCODE_FREE_MODEL_PREFIX) }

export function freeModelSource(model: string) {
  if (isKiloFreeModel(model)) return { id: 'kilo-free', name: 'Kilo Free', apiModel: model.slice(KILO_FREE_PREFIX.length) }
  if (isOpenCodeFreeModel(model)) return { id: 'opencode-free', name: 'OpenCode Free', apiModel: model.slice(OPENCODE_FREE_MODEL_PREFIX.length) }
  return undefined
}

export interface KiloFreeModel {
  id: string
  apiModel: string
  name: string
  contextLimit: number
  outputLimit: number
  toolCall: boolean
  vision: boolean
  reasoning: boolean
  parameters: string[]
}

export interface KiloFreeCatalogue {
  models: KiloFreeModel[]
  updatedAt: number | null
  stale: boolean
  error?: string
}

/** Publicly forwardable models for the global routing picker. */
export interface FreeRoutingModels {
  models: { id: string; name: string }[]
  sources: { id: string; name: string; stale: boolean; error?: string }[]
}
