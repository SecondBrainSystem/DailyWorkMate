import axios, { type AxiosResponse } from 'axios'
import { createHash } from 'node:crypto'
import { CUSTOM_API_PRESET, apiPreset, chatModelIds, type ApiModelList, type ApiPreset, type ApiProviderInput, type ApiProviderResult } from '../../shared/apiProviders.ts'
import type { Provider } from '../store/types.ts'

const TIMEOUT = 20000
export const ANTHROPIC_VERSION = '2023-06-01'

/** The key was refused (401/403), as opposed to a network or server problem. */
export class ApiKeyRejected extends Error {}

export function normalizeApiBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) throw new Error('Enter the API address')
  const url = new URL(value.trim())
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('The API address must start with https:// or http://')
  if (url.username || url.password) throw new Error('Do not put credentials in the API address')
  url.hash = ''; url.search = ''
  return url.toString().replace(/\/+$/, '')
}

export function apiKeyValue(value: unknown): string {
  const key = typeof value === 'string' ? value.trim() : ''
  if (!key || key.length > 4096 || /\s/.test(key)) throw new Error('Enter a valid API key')
  return key
}

/** Preset, region and address for an add request; a custom address replaces the preset default. */
export function resolveApiTarget(input: Pick<ApiProviderInput, 'presetId' | 'regionId' | 'baseUrl'>) {
  const preset = apiPreset(input.presetId)
  if (!preset) throw new Error('Unknown API provider')
  if (preset.id === CUSTOM_API_PRESET) return { preset, region: undefined, baseUrl: normalizeApiBaseUrl(input.baseUrl) }
  const region = preset.regions.find(item => item.id === input.regionId) ?? preset.regions[0]
  return { preset, region, baseUrl: input.baseUrl?.trim() ? normalizeApiBaseUrl(input.baseUrl) : region.baseUrl }
}

export function apiProviderId(preset: ApiPreset, baseUrl: string) {
  return preset.id === CUSTOM_API_PRESET ? 'api-custom-' + createHash('sha256').update(baseUrl).digest('hex').slice(0, 12) : 'api-' + preset.id
}

const detail = (response: AxiosResponse) => {
  const data = response.data
  const message = typeof data?.error === 'string' ? data.error : data?.error?.message || data?.message || (typeof data === 'string' ? data : '')
  return message ? ': ' + String(message).slice(0, 300) : ''
}

/** Lists the models the key can use, which also proves the key works. */
export async function listApiModels(modelList: ApiModelList, baseUrl: string, apiKey: string, request = axios.get): Promise<string[]> {
  const common = { timeout: TIMEOUT, validateStatus: () => true }
  const response = modelList === 'anthropic'
    ? await request(baseUrl + '/v1/models', { ...common, params: { limit: 1000 }, headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION } })
    // Gemini's OpenAI-compatible API has no model list; its native list includes what that API serves.
    : modelList === 'gemini'
      ? await request(new URL(baseUrl).origin + '/v1beta/models', { ...common, params: { pageSize: 1000 }, headers: { 'x-goog-api-key': apiKey } })
      : await request(baseUrl + '/models', { ...common, headers: { Authorization: 'Bearer ' + apiKey } })
  // Gemini and xAI answer an invalid key with 400 rather than 401.
  const keyProblem = response.status === 401 || response.status === 403 || (response.status === 400 && /api[ _-]?key|unauthori[sz]ed|authenticat/i.test(detail(response)))
  if (keyProblem) throw new ApiKeyRejected('The API key was rejected (HTTP ' + response.status + ')' + detail(response))
  if (response.status !== 200) throw new Error('Could not read the model list (HTTP ' + response.status + ')' + detail(response))
  const data = response.data
  const ids = modelList === 'gemini'
    ? (Array.isArray(data?.models) ? data.models : []).filter((model: any) => !Array.isArray(model?.supportedGenerationMethods) || model.supportedGenerationMethods.includes('generateContent')).map((model: any) => model?.name)
    : (Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : []).map((model: any) => typeof model === 'string' ? model : model?.id ?? model?.name)
  const models = chatModelIds(ids)
  if (!models.length) throw new Error('The API returned no chat models')
  return models
}

export async function checkApiKey(provider: Pick<Provider, 'apiPreset' | 'apiEndpoint'>, apiKey: unknown): Promise<{ valid: boolean; error?: string }> {
  try {
    await listApiModels(apiPreset(provider.apiPreset)?.modelList ?? 'openai', provider.apiEndpoint, apiKeyValue(apiKey))
    return { valid: true }
  } catch (error) { return { valid: false, error: error instanceof Error ? error.message : String(error) } }
}

/** Store operations the add flow needs; injected so the flow can be tested without Electron. */
export interface ApiProviderStore {
  getProvider(id: string): Provider | undefined
  addProvider(provider: Provider): void
  updateProvider(id: string, updates: Partial<Omit<Provider, 'id' | 'type' | 'createdAt'>>): void
  keys(providerId: string): string[]
  addKey(providerId: string, name: string, apiKey: string): string
  /** Model names served by other enabled providers. */
  otherModels(providerId: string): Set<string>
}

const identity = (models: string[]) => Object.fromEntries(models.map(model => [model, model]))

/** Verify the key, then create the provider (first key) or add the key as another account. */
export async function addApiProvider(input: ApiProviderInput, store: ApiProviderStore, list = listApiModels): Promise<ApiProviderResult> {
  if (!input || typeof input !== 'object') throw new Error('Invalid API provider request')
  const apiKey = apiKeyValue(input.apiKey)
  const { preset, region, baseUrl } = resolveApiTarget(input)
  const providerId = apiProviderId(preset, baseUrl)
  const existing = store.getProvider(providerId)
  if (existing && existing.upstreamKind !== 'api') throw new Error('Another provider already uses this ID')
  if (existing && existing.apiEndpoint !== baseUrl) throw new Error('This provider is already set up with ' + existing.apiEndpoint + '. Change its address or remove it first.')
  if (existing && store.keys(providerId).includes(apiKey)) throw new Error('This API key has already been added')
  const models = await list(preset.modelList, baseUrl, apiKey)
  const now = Date.now()
  let all = models
  if (existing) {
    all = [...new Set([...(existing.supportedModels || []), ...models])].sort((a, b) => a.localeCompare(b))
    store.updateProvider(providerId, { supportedModels: all, modelMappings: { ...identity(all), ...existing.modelMappings }, status: 'online', lastStatusCheck: now, modelsUpdatedAt: now })
  } else {
    const name = preset.id === CUSTOM_API_PRESET ? (typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 50) : new URL(baseUrl).host) : preset.name
    store.addProvider({
      id: providerId, name, type: 'custom', authType: 'token', apiEndpoint: baseUrl,
      chatPath: preset.protocol === 'anthropic' ? '/v1/messages' : '/chat/completions', headers: {}, enabled: true,
      createdAt: now, updatedAt: now, description: region?.label ?? new URL(baseUrl).host,
      supportedModels: models, modelMappings: identity(models), modelsUpdatedAt: now, status: 'online', lastStatusCheck: now,
      upstreamKind: 'api', apiPreset: preset.id, apiProtocol: preset.protocol,
      credentialFields: [{ name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: preset.keyPlaceholder || 'API key' }],
    })
  }
  const accountId = store.addKey(providerId, (existing?.name ?? preset.name) + ' ····' + apiKey.slice(-4), apiKey)
  const others = store.otherModels(providerId)
  return { providerId, accountId, models: all, addedKey: !!existing, sharedModels: models.filter(model => others.has(model)) }
}

/** Re-read the model list with the provider's first working key. */
export async function refreshApiModels(providerId: string, store: ApiProviderStore, list = listApiModels): Promise<string[]> {
  const provider = store.getProvider(providerId)
  if (!provider || provider.upstreamKind !== 'api') throw new Error('API provider not found')
  const [key] = store.keys(providerId)
  if (!key) throw new Error('Add an API key first')
  const models = await list(apiPreset(provider.apiPreset)?.modelList ?? 'openai', provider.apiEndpoint, key)
  store.updateProvider(providerId, { supportedModels: models, modelMappings: identity(models), modelsUpdatedAt: Date.now(), status: 'online', lastStatusCheck: Date.now() })
  return models
}
