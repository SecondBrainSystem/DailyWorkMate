/**
 * Official API-key providers. They sit beside the web-account providers: same proxy, same model
 * catalog, but authenticated with the vendor's own API key and billed by the vendor.
 */
export type ApiProtocol = 'openai' | 'anthropic'
/** How the model list is read: OpenAI-style `/models`, Anthropic `/v1/models`, or Gemini's native list. */
export type ApiModelList = 'openai' | 'anthropic' | 'gemini'
export interface ApiRegion { id: string; label: string; baseUrl: string; keyUrl: string }
export interface ApiPreset {
  id: string
  name: string
  protocol: ApiProtocol
  modelList: ApiModelList
  /** First region is the default. Empty for the custom OpenAI-compatible entry. */
  regions: ApiRegion[]
  /** Icon of the matching web provider, when there is one. */
  icon?: string
  keyPlaceholder?: string
}

export const CUSTOM_API_PRESET = 'openai-compatible'
export const API_PRESETS: ApiPreset[] = [
  { id: 'openai', name: 'OpenAI', protocol: 'openai', modelList: 'openai', keyPlaceholder: 'sk-…',
    regions: [{ id: 'global', label: 'api.openai.com', baseUrl: 'https://api.openai.com/v1', keyUrl: 'https://platform.openai.com/api-keys' }] },
  { id: 'anthropic', name: 'Anthropic Claude', protocol: 'anthropic', modelList: 'anthropic', keyPlaceholder: 'sk-ant-…',
    regions: [{ id: 'global', label: 'api.anthropic.com', baseUrl: 'https://api.anthropic.com', keyUrl: 'https://console.anthropic.com/settings/keys' }] },
  { id: 'gemini', name: 'Google Gemini', protocol: 'openai', modelList: 'gemini', keyPlaceholder: 'AIza…',
    regions: [{ id: 'global', label: 'generativelanguage.googleapis.com', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyUrl: 'https://aistudio.google.com/apikey' }] },
  { id: 'deepseek', name: 'DeepSeek', protocol: 'openai', modelList: 'openai', icon: 'deepseek', keyPlaceholder: 'sk-…',
    regions: [{ id: 'global', label: 'api.deepseek.com', baseUrl: 'https://api.deepseek.com', keyUrl: 'https://platform.deepseek.com/api_keys' }] },
  { id: 'zhipu', name: '智谱 GLM', protocol: 'openai', modelList: 'openai', icon: 'glm',
    regions: [
      { id: 'cn', label: '中国 · open.bigmodel.cn', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys' },
      { id: 'intl', label: 'International · api.z.ai', baseUrl: 'https://api.z.ai/api/paas/v4', keyUrl: 'https://z.ai/manage-apikey/apikey-list' },
    ] },
  { id: 'moonshot', name: 'Moonshot Kimi', protocol: 'openai', modelList: 'openai', icon: 'kimi', keyPlaceholder: 'sk-…',
    regions: [
      { id: 'cn', label: '中国 · api.moonshot.cn', baseUrl: 'https://api.moonshot.cn/v1', keyUrl: 'https://platform.moonshot.cn/console/api-keys' },
      { id: 'intl', label: 'International · api.moonshot.ai', baseUrl: 'https://api.moonshot.ai/v1', keyUrl: 'https://platform.moonshot.ai/console/api-keys' },
    ] },
  { id: 'qwen', name: '阿里百炼 Qwen', protocol: 'openai', modelList: 'openai', icon: 'qwen', keyPlaceholder: 'sk-…',
    regions: [
      { id: 'cn', label: '中国 · dashscope.aliyuncs.com', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', keyUrl: 'https://bailian.console.aliyun.com/?apiKey=1' },
      { id: 'intl', label: 'International · dashscope-intl', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', keyUrl: 'https://modelstudio.console.alibabacloud.com/?apiKey=1' },
    ] },
  { id: 'minimax', name: 'MiniMax', protocol: 'openai', modelList: 'openai', icon: 'minimax',
    regions: [
      { id: 'cn', label: '中国 · api.minimaxi.com', baseUrl: 'https://api.minimaxi.com/v1', keyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key' },
      { id: 'intl', label: 'International · api.minimax.io', baseUrl: 'https://api.minimax.io/v1', keyUrl: 'https://www.minimax.io/platform/user-center/basic-information/interface-key' },
    ] },
  { id: 'xai', name: 'xAI Grok', protocol: 'openai', modelList: 'openai', keyPlaceholder: 'xai-…',
    regions: [{ id: 'global', label: 'api.x.ai', baseUrl: 'https://api.x.ai/v1', keyUrl: 'https://console.x.ai' }] },
  { id: CUSTOM_API_PRESET, name: 'OpenAI Compatible', protocol: 'openai', modelList: 'openai', regions: [] },
]

export const apiPreset = (id: string | undefined) => API_PRESETS.find(preset => preset.id === id)

/** Model IDs that do not take chat requests: embeddings, speech, images, moderation, Responses-only models. */
const NON_CHAT = /(embed|rerank|moderation|whisper|tts|transcribe|dall-e|gpt-image|imagen|veo|audio|realtime|speech|paraformer|cosyvoice|sambert|wanx|wan2|aqa|computer-use|deep-research|codex|(^|-)o\d+-pro|gpt-5(\.\d+)?-pro|^babbage|^davinci)/i
export function chatModelIds(ids: unknown[]): string[] {
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0 && id.length <= 200).map(id => id.trim().replace(/^models\//, '')))]
    .filter(id => !NON_CHAT.test(id)).sort((a, b) => a.localeCompare(b))
}

export interface ApiProviderInput {
  presetId: string
  regionId?: string
  /** Required for the custom entry; overrides the preset address otherwise. */
  baseUrl?: string
  apiKey: string
  /** Display name for the custom entry. */
  name?: string
}
export interface ApiProviderResult {
  providerId: string
  accountId: string
  models: string[]
  /** The preset was already configured; the key was added as another account. */
  addedKey: boolean
  /** Model names also served by other providers; requests rotate between them. */
  sharedModels: string[]
}
