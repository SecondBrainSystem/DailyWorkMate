import type { ModelMapping } from './types'

export const DEFAULT_DEEPSEEK_MODEL_MAPPINGS: Record<string, ModelMapping> = {
  'deepseek-v4-flash-think': {
    requestModel: 'deepseek-v4-flash-think',
    actualModel: 'deepseek-v4-flash',
    preferredProviderId: 'deepseek',
  },
  'deepseek-v4-flash-search': {
    requestModel: 'deepseek-v4-flash-search',
    actualModel: 'deepseek-v4-flash',
    preferredProviderId: 'deepseek',
  },
  'deepseek-v4-flash-think-search': {
    requestModel: 'deepseek-v4-flash-think-search',
    actualModel: 'deepseek-v4-flash',
    preferredProviderId: 'deepseek',
  },
  'deepseek-v4-pro-think': {
    requestModel: 'deepseek-v4-pro-think',
    actualModel: 'deepseek-v4-pro',
    preferredProviderId: 'deepseek',
  },
  'deepseek-v4-pro-search': {
    requestModel: 'deepseek-v4-pro-search',
    actualModel: 'deepseek-v4-pro',
    preferredProviderId: 'deepseek',
  },
  'deepseek-v4-pro-think-search': {
    requestModel: 'deepseek-v4-pro-think-search',
    actualModel: 'deepseek-v4-pro',
    preferredProviderId: 'deepseek',
  },
}
