import axios, { type AxiosRequestConfig, type AxiosResponse } from 'axios'
import { createHash } from 'node:crypto'
import { AccountManager } from '../store/accounts'
import { ProviderManager } from '../store/providers'
import { storeManager } from '../store/store'
import { parseOllamaUrlList } from './urls'
import { buildOllamaHeaders, isOllamaResponse, mergeOllamaAuth } from './transport'
import { createOllamaAgents } from '../proxy/connectionAgents'
import { impossibleTimingReason, syntheticCatalogReason } from './authenticity'
import type {
  Account,
  OllamaAuthInput,
  OllamaAuthType,
  OllamaEndpoint,
  OllamaImportResult,
  OllamaModelMetadata,
  OllamaNodeSummary,
  Provider,
  VisionSupport,
} from '../../shared/types'

const DISCOVERY_TIMEOUT = 5000
const PROBE_TIMEOUT = 15000
const TEST_IMAGE_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAABmJLR0QA/wD/AP+gvaeTAAAAFElEQVQImWP8z8Dwn4GBgYGJAQoAHxcCAr7cGDwAAAAASUVORK5CYII='

type EndpointProbe = {
  endpoint: OllamaEndpoint
  path: string
  body: (model: string) => Record<string, unknown>
}

const ENDPOINT_PROBES: EndpointProbe[] = [
  {
    endpoint: 'ollama_chat',
    path: '/api/chat',
    body: model => ({
      model,
      messages: [{ role: 'user', content: 'Reply with OK.' }],
      stream: false,
      think: false,
      options: { num_predict: 256 },
    }),
  },
  {
    endpoint: 'openai_chat',
    path: '/v1/chat/completions',
    body: model => ({
      model,
      messages: [{ role: 'user', content: 'Reply with OK.' }],
      stream: false,
      max_tokens: 256,
    }),
  },
  {
    endpoint: 'ollama_generate',
    path: '/api/generate',
    body: model => ({ model, prompt: 'Reply with OK.', stream: false, think: false, options: { num_predict: 256 } }),
  },
  {
    endpoint: 'openai_completion',
    path: '/v1/completions',
    body: model => ({ model, prompt: 'Reply with OK.', stream: false, max_tokens: 256 }),
  },
  {
    endpoint: 'claude_chat',
    path: '/v1/messages',
    body: model => ({
      model,
      messages: [{ role: 'user', content: 'Reply with OK.' }],
      max_tokens: 256,
      stream: false,
    }),
  },
]

function providerIdForUrl(url: string): string {
  return `ollama-${createHash('sha256').update(url).digest('hex').slice(0, 16)}`
}

function providerNameForUrl(url: string): string {
  const parsed = new URL(url)
  return `Ollama ${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`
}

function getNodeAccount(providerId: string): Account | undefined {
  return AccountManager.getByProviderId(providerId, true)[0]
}

function logNode(
  level: 'debug' | 'info' | 'warn' | 'error',
  provider: Provider,
  message: string,
  data?: Record<string, unknown>,
): void {
  storeManager.addLog(level, `[Ollama] ${message}`, {
    providerId: provider.id,
    data: {
      node: provider.name,
      endpoint: provider.apiEndpoint,
      ...data,
    },
  })
}

function getAuthType(account?: Account): OllamaAuthType {
  const type = account?.credentials?.authType
  return type === 'basic' || type === 'bearer' || type === 'api-key' ? type : 'none'
}

function toSummary(provider: Provider): OllamaNodeSummary {
  return {
    ...provider,
    authTypeLabel: getAuthType(getNodeAccount(provider.id)),
    modelCount: Object.keys(provider.ollamaModels || {}).length,
    disabledModels: storeManager.getModelOverrides(provider.id)?.excludedModels || [],
  }
}

function extractModelNames(data: any): string[] {
  const rawModels = Array.isArray(data?.models) ? data.models : Array.isArray(data?.data) ? data.data : []
  return Array.from(new Set(rawModels
    .map((item: any) => typeof item === 'string' ? item : item?.model || item?.name || item?.id)
    .filter((name: unknown): name is string => typeof name === 'string' && name.length > 0)))
}

function visionFromShow(data: any): VisionSupport {
  if (Array.isArray(data?.capabilities)) {
    return data.capabilities.includes('vision') ? 'supported' : 'unsupported'
  }
  const families = [
    ...(Array.isArray(data?.details?.families) ? data.details.families : []),
    data?.details?.family,
  ].filter(Boolean).map((value: unknown) => String(value).toLowerCase())
  return families.some(family => family.includes('clip') || family.includes('vision'))
    ? 'supported'
    : 'unknown'
}

export async function discoverModels(baseUrl: string, headers: Record<string, string>, signal?: AbortSignal): Promise<string[]> {
  return (await discoverCatalog(baseUrl, headers, signal)).models
}

async function discoverCatalog(baseUrl: string, headers: Record<string, string>, signal?: AbortSignal): Promise<{
  models: string[]; endpoint: OllamaEndpoint; imitation?: string
}> {
  let lastError = ''
  for (const path of ['/api/tags', '/v1/models']) {
    signal?.throwIfAborted()
    try {
      const response = await axios.get(`${baseUrl}${path}`, {
        headers,
        timeout: DISCOVERY_TIMEOUT,
        ...createOllamaAgents(DISCOVERY_TIMEOUT),
        signal, maxRedirects: 0,
        validateStatus: () => true,
      })
      if (response.status >= 200 && response.status < 300) {
        const models = extractModelNames(response.data)
        if (models.length > 0 || Array.isArray(response.data?.models) || Array.isArray(response.data?.data)) {
          return { models, endpoint: path === '/api/tags' ? 'ollama_chat' : 'openai_chat', imitation: path === '/api/tags' ? syntheticCatalogReason(response.data) : undefined }
        }
      }
      if (response.status === 401 || response.status === 403) throw new Error(`Authentication failed (HTTP ${response.status})`)
      lastError = `HTTP ${response.status} from ${path}`
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.message.startsWith('Authentication failed'))) throw error
      lastError = error instanceof Error ? error.message : String(error)
    }
  }
  throw new Error(`Unable to discover models from /api/tags or /v1/models: ${lastError}`)
}

export async function detectVision(baseUrl: string, model: string, headers: Record<string, string>, signal?: AbortSignal): Promise<{
  vision: VisionSupport
  visionSource?: 'api-show'
}> {
  try {
    const response = await axios.post(`${baseUrl}/api/show`, { model }, {
      headers,
      timeout: DISCOVERY_TIMEOUT,
      ...createOllamaAgents(DISCOVERY_TIMEOUT),
      signal, maxRedirects: 0,
      validateStatus: () => true,
    })
    if (response.status >= 200 && response.status < 300) {
      return { vision: visionFromShow(response.data), visionSource: 'api-show' }
    }
  } catch (error) {
    if (signal?.aborted) throw error
    // Metadata is optional on compatibility servers.
  }
  return { vision: 'unknown' }
}

export async function probeEndpoint(baseUrl: string, model: string, headers: Record<string, string>, signal?: AbortSignal, timeout = PROBE_TIMEOUT, preferredEndpoint?: OllamaEndpoint): Promise<{
  endpoint?: OllamaEndpoint
  latency?: number
  error?: string
  /** Native replies whose reported timing is impossible come from a server imitating Ollama. */
  imitation?: string
}> {
  let lastError = 'No compatible invocation endpoint returned a usable response'
  const probes = [...ENDPOINT_PROBES].sort((a, b) => Number(b.endpoint === preferredEndpoint) - Number(a.endpoint === preferredEndpoint))
  for (const probe of probes) {
    signal?.throwIfAborted()
    const start = Date.now()
    try {
      const response = await axios.post(`${baseUrl}${probe.path}`, probe.body(model), {
        headers: probe.endpoint === 'claude_chat' ? { ...headers, 'anthropic-version': '2023-06-01' } : headers,
        timeout,
        ...createOllamaAgents(timeout),
        signal, maxRedirects: 0,
        validateStatus: () => true,
      })
      if (response.status >= 200 && response.status < 300 && isOllamaResponse(response.data, probe.endpoint, true)) {
        const latency = Date.now() - start
        const imitation = probe.endpoint.startsWith('ollama_') ? impossibleTimingReason(response.data, latency) : undefined
        return imitation ? { error: imitation, imitation, latency } : { endpoint: probe.endpoint, latency }
      }
      lastError = `HTTP ${response.status} from ${probe.path}`
      if (response.status === 401 || response.status === 403) return { error: `Authentication failed: ${lastError}` }
    } catch (error) {
      if (signal?.aborted) throw error
      lastError = error instanceof Error ? error.message : String(error)
    }
  }
  return { error: lastError }
}

async function scanModel(baseUrl: string, model: string, headers: Record<string, string>, signal?: AbortSignal, timeout?: number, preferredEndpoint?: OllamaEndpoint): Promise<OllamaModelMetadata & { imitation?: string }> {
  const [{ imitation, ...endpoint }, vision] = await Promise.all([
    probeEndpoint(baseUrl, model, headers, signal, timeout, preferredEndpoint),
    detectVision(baseUrl, model, headers, signal),
  ])
  return {
    name: model,
    ...endpoint,
    ...vision,
    testStatus: endpoint.endpoint ? 'passed' : 'failed',
    testedAt: Date.now(),
    ...(imitation ? { imitation } : {}),
  }
}

function createNodeProvider(url: string): Provider {
  const now = Date.now()
  return {
    id: providerIdForUrl(url),
    name: providerNameForUrl(url),
    type: 'custom',
    authType: 'token',
    apiEndpoint: url,
    headers: {},
    enabled: true,
    createdAt: now,
    updatedAt: now,
    description: 'Imported Ollama-compatible upstream node',
    supportedModels: [],
    modelMappings: {},
    status: 'unknown',
    upstreamKind: 'ollama',
    ollamaModels: {},
  }
}

export class OllamaNodeManager {
  private static scans = new Map<string, { controller: AbortController; promise: Promise<OllamaNodeSummary> }>()
  private static scanProgress = new Map<string, { providerId: string; model: string; completed: number; total: number }>()

  static getScanProgress() {
    return Array.from(this.scanProgress.values(), progress => ({ ...progress }))
  }

  static cancelScan(providerId: string): void {
    this.scans.get(providerId)?.controller.abort()
    this.modelTests.get(providerId)?.abort()
  }
  private static recoveryTimer: NodeJS.Timeout | undefined
  static startRecovery(): void {
    if (this.recoveryTimer) return
    this.recoveryTimer = setInterval(() => {
      if (this.scans.size || this.modelTests.size || this.visionTests.size) return
      const node = ProviderManager.getAll().find(provider => provider.upstreamKind === 'ollama' && provider.enabled && (provider.status === 'offline' || provider.status === 'unknown') && Date.now() - (provider.lastStatusCheck || 0) >= 60000)
      if (node) void this.scan(node.id).catch(error => console.error('[Ollama] Recovery failed:', error instanceof Error ? error.message : String(error)))
    }, 60000)
    this.recoveryTimer.unref()
  }
  static stopRecovery(): void {
    clearInterval(this.recoveryTimer)
    this.recoveryTimer = undefined
    for (const entry of this.scans.values()) entry.controller.abort()
    for (const controller of this.modelTests.values()) controller.abort()
    for (const controller of this.visionTests.values()) controller.abort()
  }
  private static visionTests = new Map<string, AbortController>()
  private static modelTests = new Map<string, AbortController>()

  private static cancelOperations(providerId: string): void {
    this.scans.get(providerId)?.controller.abort()
    this.scans.delete(providerId)
    this.scanProgress.delete(providerId)
    this.visionTests.get(providerId)?.abort()
    this.visionTests.delete(providerId)
    this.modelTests.get(providerId)?.abort()
    this.modelTests.delete(providerId)
  }

  static list(): OllamaNodeSummary[] {
    return ProviderManager.getAll().filter(provider => provider.upstreamKind === 'ollama').map(toSummary)
  }

  static async importText(text: string): Promise<OllamaImportResult> {
    const { urls, invalid } = parseOllamaUrlList(text)
    let imported = 0
    let refreshed = 0

    for (const url of urls) {
      const id = providerIdForUrl(url)
      let provider = ProviderManager.getById(id)
      if (!provider) {
        provider = createNodeProvider(url)
        storeManager.addProvider(provider)
        AccountManager.create({ providerId: provider.id, name: provider.name, credentials: { authType: 'none' } })
        imported++
      } else {
        if (!getNodeAccount(provider.id)) {
          AccountManager.create({ providerId: provider.id, name: provider.name, credentials: { authType: 'none' } })
        }
        refreshed++
      }
    }

    return { imported, refreshed, invalid, nodes: this.list() }
  }

  static scan(providerId: string): Promise<OllamaNodeSummary> {
    const existing = this.scans.get(providerId)
    if (existing) return existing.promise
    if (this.modelTests.has(providerId)) throw new Error('This node already has a test in progress')
    this.visionTests.get(providerId)?.abort()
    const controller = new AbortController()
    this.scanProgress.set(providerId, { providerId, model: '', completed: 0, total: 0 })
    const promise = this.scanNode(providerId, controller.signal).finally(() => {
      if (this.scans.get(providerId)?.controller === controller) {
        this.scans.delete(providerId)
        this.scanProgress.delete(providerId)
      }
    })
    this.scans.set(providerId, { controller, promise })
    return promise
  }

  private static async scanNode(providerId: string, signal: AbortSignal): Promise<OllamaNodeSummary> {
    const provider = ProviderManager.getById(providerId)
    if (!provider || provider.upstreamKind !== 'ollama') {
      throw new Error('Ollama node not found')
    }
    const account = getNodeAccount(providerId)
    const headers = buildOllamaHeaders(account, provider.headers)
    logNode('info', provider, 'Node scan started')

    try {
      const { models, endpoint, imitation } = await discoverCatalog(provider.apiEndpoint, headers, signal)
      this.scanProgress.set(providerId, { providerId, model: '', completed: 0, total: models.length })
      logNode('info', provider, `Discovered ${models.length} model(s)`, { models })
      signal.throwIfAborted()
      const currentProvider = ProviderManager.getById(providerId)
      if (!currentProvider) throw new Error('Ollama node was deleted during its scan')
      // Refresh only the catalog. Keep explicit test results; retire errors from old bulk probes.
      const ollamaModels = Object.fromEntries(models.map(name => {
        const previous = currentProvider.ollamaModels?.[name]
        return [name, previous?.testStatus ? { ...previous, endpoint: previous.endpoint || endpoint } : {
          name, endpoint: previous?.endpoint || endpoint, testStatus: 'untested' as const,
          vision: previous?.vision || 'unknown' as const, visionSource: previous?.visionSource,
        }]
      }))
      const supportedModels = models
      const modelMappings = Object.fromEntries(supportedModels.map(model => [model, model]))

      const updated = ProviderManager.update(providerId, {
        supportedModels,
        modelMappings,
        ollamaModels,
        status: 'online',
        lastStatusCheck: Date.now(),
        lastScanError: models.length === 0 ? 'This node has no installed models' : undefined,
        ...(imitation ? { imitationWarning: imitation } : {}),
      })
      if (imitation) logNode('warn', updated!, `Node imitates Ollama: ${imitation}`)
      if (account) {
        AccountManager.update(account.id, {
          status: 'active',
          errorMessage: undefined,
        })
      }
      logNode('info', updated!, `Catalog refreshed: ${models.length} model(s); no inference tests run`)
      return toSummary(updated!)
    } catch (error) {
      // Cancelled scans must not overwrite a new credential set or a deleted node.
      if (signal.aborted) throw new Error('Ollama node scan cancelled')
      const message = error instanceof Error ? error.message : String(error)
      const updated = ProviderManager.update(providerId, {
        status: 'offline',
        lastStatusCheck: Date.now(),
        lastScanError: message,
      })
      if (account) AccountManager.update(account.id, { status: 'error', errorMessage: message })
      logNode('error', updated!, `Node scan failed: ${message}`)
      return toSummary(updated!)
    }
  }

  static async testModel(providerId: string, model: string): Promise<OllamaModelMetadata> {
    if (typeof providerId !== 'string' || !providerId || typeof model !== 'string' || !model.trim()) {
      throw new Error('A node ID and model name are required')
    }
    const provider = ProviderManager.getById(providerId)
    if (!provider || provider.upstreamKind !== 'ollama') throw new Error('Ollama node not found')
    if (!provider.ollamaModels?.[model]) throw new Error('Ollama model not found')
    if (this.scans.has(providerId) || this.modelTests.has(providerId) || this.visionTests.has(providerId)) {
      throw new Error('This node already has a test in progress')
    }
    const controller = new AbortController()
    this.modelTests.set(providerId, controller)
    this.scanProgress.set(providerId, { providerId, model, completed: 0, total: 1 })
    try {
      logNode('info', provider, `Model test started: ${model}`, { model })
      const timeout = Math.min(Math.max(storeManager.getConfig().requestTimeout || 120000, 1000), 300000)
      const { imitation, ...result } = await scanModel(provider.apiEndpoint, model, buildOllamaHeaders(getNodeAccount(providerId), provider.headers), controller.signal, timeout, provider.ollamaModels[model].endpoint)
      controller.signal.throwIfAborted()
      const current = ProviderManager.getById(providerId)
      if (!current) throw new Error('Ollama node was deleted during its model test')
      const previous = current.ollamaModels?.[model]
      const metadata: OllamaModelMetadata = {
        ...result,
        endpoint: result.endpoint || previous?.endpoint,
        ...(previous?.visionSource === 'manual-test' && result.vision === 'unknown'
          ? { vision: previous.vision, visionSource: previous.visionSource } : {}),
      }
      // A model test affects only this row, never the node's account or other models.
      ProviderManager.update(providerId, { ollamaModels: { ...(current.ollamaModels || {}), [model]: metadata }, ...(imitation ? { imitationWarning: imitation } : {}) })
      if (imitation) logNode('warn', provider, `Node imitates Ollama: ${imitation}`, { model })
      logNode(result.testStatus === 'passed' ? 'info' : 'warn', provider, `Model test ${result.testStatus}: ${model}`, { model, error: result.error })
      return metadata
    } catch (error) {
      if (controller.signal.aborted) throw new Error('Ollama node scan cancelled')
      logNode('error', provider, `Model test failed: ${model}`, { model, error: error instanceof Error ? error.message : String(error) })
      throw error
    } finally {
      if (this.modelTests.get(providerId) === controller) {
        this.modelTests.delete(providerId)
        this.scanProgress.delete(providerId)
      }
    }
  }

  static update(providerId: string, updates: { enabled?: boolean; name?: string }): OllamaNodeSummary {
    const provider = ProviderManager.getById(providerId)
    if (!provider || provider.upstreamKind !== 'ollama') throw new Error('Ollama node not found')
    if (!updates || (updates.enabled !== undefined && typeof updates.enabled !== 'boolean')
      || (updates.name !== undefined && (typeof updates.name !== 'string' || !updates.name.trim()))) throw new Error('Invalid node update')
    return toSummary(ProviderManager.update(providerId, {
      ...(updates.enabled === undefined ? {} : { enabled: updates.enabled }),
      ...(updates.name === undefined ? {} : { name: updates.name.trim() }),
    })!)
  }

  static setModelEnabled(providerId: string, model: string, enabled: boolean): OllamaNodeSummary {
    const provider = ProviderManager.getById(providerId)
    if (!provider || provider.upstreamKind !== 'ollama') throw new Error('Ollama node not found')
    if (!provider.ollamaModels?.[model]?.endpoint) throw new Error('This model has no usable endpoint')
    if (enabled) storeManager.restoreModel(providerId, model)
    else storeManager.removeModel(providerId, model)
    return toSummary(provider)
  }

  static updateAuth(providerId: string, auth: OllamaAuthInput): OllamaNodeSummary {
    const provider = ProviderManager.getById(providerId)
    if (!provider || provider.upstreamKind !== 'ollama') throw new Error('Ollama node not found')
    const account = getNodeAccount(providerId)
    if (!account) throw new Error('Ollama node account not found')
    const credentials = mergeOllamaAuth(auth, account.credentials)
    this.cancelOperations(providerId)
    AccountManager.update(account.id, {
      credentials,
      status: 'active',
      errorMessage: undefined,
    })
    logNode('info', provider, `Authentication updated: ${auth.type}`)
    return toSummary(provider)
  }

  static delete(providerId: string): boolean {
    const provider = ProviderManager.getById(providerId)
    if (provider?.upstreamKind !== 'ollama') return false
    this.cancelOperations(providerId)
    // Preserve strict pins: deletion must not silently send prompts to another node.
    return ProviderManager.delete(providerId)
  }

  static pinModel(model: string, providerId?: string): void {
    const config = storeManager.getConfig()
    const modelMappings = { ...config.modelMappings }
    if (providerId) {
      const provider = ProviderManager.getById(providerId)
      const enabledModels = storeManager.getEffectiveModels(providerId).map(item => item.displayName)
      if (!provider || provider.upstreamKind !== 'ollama' || !enabledModels.includes(model)) {
        throw new Error('The selected Ollama node does not expose this model')
      }
      modelMappings[model] = { ...modelMappings[model], requestModel: model, actualModel: modelMappings[model]?.actualModel || model, preferredProviderId: providerId }
    } else {
      const mapping = modelMappings[model]
      if (mapping) {
        const { preferredProviderId: _provider, preferredAccountId: _account, ...unpinned } = mapping
        modelMappings[model] = unpinned
      }
    }
    storeManager.updateConfig({ modelMappings })
  }

  static async testVision(providerId: string, model: string): Promise<OllamaModelMetadata> {
    const provider = ProviderManager.getById(providerId)
    if (!provider || provider.upstreamKind !== 'ollama') throw new Error('Ollama node not found')
    if (!provider.ollamaModels?.[model]) throw new Error('Ollama model not found')
    if (this.scans.has(providerId) || this.modelTests.has(providerId) || this.visionTests.has(providerId)) throw new Error('This node already has a test in progress')
    const account = getNodeAccount(providerId)
    const headers = buildOllamaHeaders(account, provider.headers)
    const controller = new AbortController()
    this.visionTests.set(providerId, controller)
    try {
      logNode('info', provider, `Vision test started: ${model}`, { model })
      const result = await this.runVisionRequest(provider.apiEndpoint, model, headers, controller.signal)
      controller.signal.throwIfAborted()
      const current = ProviderManager.getById(providerId)
      if (!current) throw new Error('Ollama node was deleted during its vision test')
      const existing = current.ollamaModels?.[model] || { name: model, vision: 'unknown' as const }
      const metadata: OllamaModelMetadata = {
        ...existing,
        vision: result,
        visionSource: 'manual-test',
        testedAt: Date.now(),
      }
      ProviderManager.update(providerId, {
        ollamaModels: { ...(current.ollamaModels || {}), [model]: metadata },
      })
      logNode(result === 'supported' ? 'info' : 'warn', provider, `Vision test completed: ${model} is ${result}`, {
        model,
        vision: result,
      })
      return metadata
    } finally {
      if (this.visionTests.get(providerId) === controller) this.visionTests.delete(providerId)
    }
  }

  private static async runVisionRequest(
    baseUrl: string,
    model: string,
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<VisionSupport> {
    const requests: AxiosRequestConfig[] = [
      {
        method: 'POST',
        url: `${baseUrl}/api/chat`,
        data: {
          model,
          messages: [{ role: 'user', content: 'Reply with exactly RED if the image is red.', images: [TEST_IMAGE_BASE64] }],
          stream: false,
          options: { num_predict: 16 },
        },
      },
      {
        method: 'POST',
        url: `${baseUrl}/v1/chat/completions`,
        data: {
          model,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: 'Reply with exactly RED if the image is red.' },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${TEST_IMAGE_BASE64}` } },
            ],
          }],
          stream: false,
          max_tokens: 16,
        },
      },
    ]
    let explicitUnsupported = false
    for (const request of requests) {
      signal.throwIfAborted()
      try {
        const response: AxiosResponse = await axios.request({
          ...request,
          headers,
          timeout: PROBE_TIMEOUT,
          ...createOllamaAgents(PROBE_TIMEOUT),
          signal, maxRedirects: 0,
          validateStatus: () => true,
        })
        const text = JSON.stringify(response.data || '').toLowerCase()
        const answer = response.data?.message?.content ?? response.data?.choices?.[0]?.message?.content
        if (response.status >= 200 && response.status < 300 && !response.data?.error
          && typeof answer === 'string' && /^red[.!]?$/i.test(answer.trim())) return 'supported'
        if (/vision|image|multimodal/.test(text) && /not support|unsupported|does not support/.test(text)) {
          explicitUnsupported = true
        }
      } catch (error) {
        if (signal.aborted) throw error
        // Continue to the compatibility fallback.
      }
    }
    return explicitUnsupported ? 'unsupported' : 'unknown'
  }
}

export default OllamaNodeManager
