export type FeatureMode = 'auto' | 'enabled' | 'disabled'

export interface ModelFeatureDefaults {
  vision: FeatureMode
  thinking: FeatureMode
}

export const DEFAULT_MODEL_FEATURES: ModelFeatureDefaults = { vision: 'auto', thinking: 'auto' }

export function isFeatureMode(value: unknown): value is FeatureMode {
  return value === 'auto' || value === 'enabled' || value === 'disabled'
}

export function normalizeModelFeatureDefaults(value: unknown): ModelFeatureDefaults {
  const input = value && typeof value === 'object' ? value as Partial<ModelFeatureDefaults> : {}
  return {
    vision: isFeatureMode(input.vision) ? input.vision : 'auto',
    thinking: isFeatureMode(input.thinking) ? input.thinking : 'auto',
  }
}

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type ThinkingLevel = 'low' | 'medium' | 'high' | 'max'

export interface ModelFeatureInput {
  enable_vision?: boolean
  vision?: boolean
  enable_thinking?: boolean
  think?: boolean | ThinkingLevel
  thinking?: boolean | { type: 'enabled' | 'disabled' | 'adaptive'; budget_tokens?: number; [key: string]: unknown }
  reasoning_effort?: ReasoningEffort | false
  reasoningEffort?: ReasoningEffort | false
  chat_template_kwargs?: { thinking?: boolean; enable_thinking?: boolean; [key: string]: unknown }
  extra_body?: Record<string, unknown>
}

/** Explicit booleans precede effort and model-name defaults. In particular, false is never absent. */
export function explicitThinking(input: ModelFeatureInput): boolean | undefined {
  if (typeof input.enable_thinking === 'boolean') return input.enable_thinking
  if (typeof input.think === 'boolean') return input.think
  if (typeof input.think === 'string') return true
  if (typeof input.thinking === 'boolean') return input.thinking
  if (input.thinking?.type) return input.thinking.type !== 'disabled'
  if (typeof input.chat_template_kwargs?.thinking === 'boolean') return input.chat_template_kwargs.thinking
  if (typeof input.chat_template_kwargs?.enable_thinking === 'boolean') return input.chat_template_kwargs.enable_thinking
  const effort = input.reasoning_effort ?? input.reasoningEffort
  if (effort !== undefined) return effort !== false && effort !== 'none'
  return undefined
}

export function thinkingForModel(input: ModelFeatureInput & { model: string; originalModel?: string }, fallback = false): boolean {
  const explicit = explicitThinking(input)
  if (explicit !== undefined) return explicit
  const model = (input.originalModel || input.model).toLowerCase()
  if (model.endsWith('-fast')) return false
  return /think|reasoner|r1|zero/.test(model) || fallback
}
