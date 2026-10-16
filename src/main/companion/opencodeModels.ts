import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const OPENCODE_FREE_PROVIDER_ID = 'opencode-free'
export const OPENCODE_FREE_MODEL_PREFIX = OPENCODE_FREE_PROVIDER_ID + '/'
export const OPENCODE_INFERENCE_BASE_URL = 'https://opencode.ai/inference/v1'
export const OPENCODE_OPENAI_BASE_URL = 'https://opencode.ai/inference/openai/v1'
export const OPENCODE_ANTHROPIC_BASE_URL = 'https://opencode.ai/inference/anthropic/v1'
// Older official catalogues used Zen; accept that exact base while migrating requests.
export const OPENCODE_ZEN_BASE_URL = 'https://opencode.ai/zen/v1'
const LEGACY_API_BASES = new Set([OPENCODE_INFERENCE_BASE_URL, OPENCODE_ZEN_BASE_URL])
// This is OpenCode's documented source-code default for anonymous free models,
// not an account credential. Free-tier access may still require its native runtime.
export const OPENCODE_PUBLIC_API_KEY = 'public'
export const OPENCODE_MODEL_CATALOGUE_URL = 'https://models.dev/api.json'
export const OPENCODE_FREE_CATALOGUE_TTL = 6 * 60 * 60 * 1000
const RETRY_AFTER = 60_000
const MAX_CATALOGUE_BYTES = 24 * 1024 * 1024
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/
const PROTOCOLS = { '@ai-sdk/openai-compatible': 'chat-completions', '@ai-sdk/openai': 'responses', '@ai-sdk/anthropic': 'messages' } as const
type OpenCodeModelSDK = keyof typeof PROTOCOLS

export interface OpenCodeFreeModel {
  id: string
  apiModel: string
  name: string
  contextLimit: number
  outputLimit: number
  toolCall: boolean
  vision: boolean
  reasoning: boolean
  temperature: boolean
  interleaved?: boolean | { field: string }
  sdk: OpenCodeModelSDK
  protocol: typeof PROTOCOLS[OpenCodeModelSDK]
}

export interface OpenCodeFreeCatalogue {
  models: OpenCodeFreeModel[]
  updatedAt: number | null
  stale: boolean
  error?: string
}

export class OpenCodeModelError extends Error {
  readonly status: number
  constructor(message: string, status: number) { super(message); this.name = 'OpenCodeModelError'; this.status = status }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function isZeroCost(value: unknown): boolean {
  const cost = record(value)
  if (!cost || cost.input !== 0 || cost.output !== 0) return false
  const zero = (item: unknown): boolean => typeof item === 'number' ? item === 0 : !!record(item) && Object.values(record(item)!).every(zero)
  // Reject nonzero cache prices and context-dependent pricing, too.
  return Object.values(cost).every(zero)
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function officialApiBase(value: unknown, sdk: unknown): boolean {
  if (typeof value !== 'string') return false
  if (LEGACY_API_BASES.has(value)) return true
  return sdk === '@ai-sdk/anthropic' ? value === OPENCODE_ANTHROPIC_BASE_URL
    : (sdk === '@ai-sdk/openai' || sdk === '@ai-sdk/openai-compatible') && value === OPENCODE_OPENAI_BASE_URL
}

/** Listing stays at /inference/v1/models; inference now uses protocol-specific routes.
 * Derive trusted endpoints here so old metadata caches also migrate without storing URLs. */
export function openCodeFreeModelBaseURL(model: OpenCodeFreeModel): string {
  return model.protocol === 'messages' ? OPENCODE_ANTHROPIC_BASE_URL : OPENCODE_OPENAI_BASE_URL
}

function interleaved(value: unknown): boolean | { field: string } | undefined {
  if (typeof value === 'boolean') return value
  const field = record(value)?.field
  return typeof field === 'string' && /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(field) ? { field } : undefined
}

export function isOpenCodeFreeModel(model: string): boolean { return model.startsWith(OPENCODE_FREE_MODEL_PREFIX) }

/** Use the official live listing and pricing catalogue together; never infer free from a name. */
export function parseOpenCodeFreeModels(catalogue: unknown, liveModels: unknown): OpenCodeFreeModel[] {
  const provider = record(record(catalogue)?.opencode)
  const models = record(provider?.models)
  const live = record(liveModels)?.data
  if (!provider || !models || !Array.isArray(live) || !officialApiBase(provider.api, provider.npm) || provider.npm !== '@ai-sdk/openai-compatible') {
    throw new OpenCodeModelError('OpenCode 官方模型目录格式不正确，暂时无法确认免费模型。', 503)
  }
  const ids = new Set(live.map(item => record(item)?.id).filter((id): id is string => typeof id === 'string' && MODEL_ID.test(id)))
  return Object.entries(models).flatMap(([id, value]): OpenCodeFreeModel[] => {
    const model = record(value)
    const limit = record(model?.limit)
    const override = record(model?.provider)
    const modalities = record(model?.modalities)
    const sdk = override?.npm ?? provider.npm
    if (!model || !MODEL_ID.test(id) || model.id !== id || !ids.has(id) || !isZeroCost(model.cost)
      || ['deprecated', 'retired', 'disabled'].includes(String(model.status))
      || typeof sdk !== 'string' || !Object.hasOwn(PROTOCOLS, sdk)
      || (override?.api !== undefined && !officialApiBase(override.api, sdk))
      || !Array.isArray(modalities?.input) || !modalities.input.includes('text')
      || !Array.isArray(modalities?.output) || !modalities.output.includes('text')
      || !positiveInteger(limit?.context) || !positiveInteger(limit?.output)) return []
    const name = typeof model.name === 'string' && model.name.length <= 120 && !/[\x00-\x1f\x7f]/.test(model.name) ? model.name : id
    return [{ id: OPENCODE_FREE_MODEL_PREFIX + id, apiModel: id, name, contextLimit: limit.context, outputLimit: limit.output,
      toolCall: model.tool_call === true, vision: modalities.input.includes('image'), reasoning: model.reasoning === true,
      temperature: model.temperature === true, ...(interleaved(model.interleaved) === undefined ? {} : { interleaved: interleaved(model.interleaved) }),
      sdk: sdk as OpenCodeModelSDK, protocol: PROTOCOLS[sdk as OpenCodeModelSDK] }]
  }).sort((a, b) => a.name.localeCompare(b.name))
}

interface CatalogueOptions { fetch?: typeof fetch; now?: () => number; cachePath?: string }
interface StoredCatalogue { models: OpenCodeFreeModel[]; updatedAt: number }

export class OpenCodeFreeModelCatalogue {
  private readonly request: typeof fetch
  private readonly now: () => number
  private readonly cachePath?: string
  private stored: StoredCatalogue | null = null
  private loaded = false
  private loading: Promise<void> | null = null
  private lastAttempt: number | null = null
  private error: string | undefined
  private refreshing: Promise<OpenCodeFreeCatalogue> | null = null

  constructor(options: CatalogueOptions = {}) { this.request = options.fetch ?? fetch; this.now = options.now ?? Date.now; this.cachePath = options.cachePath }

  private snapshot(): OpenCodeFreeCatalogue {
    return { models: structuredClone(this.stored?.models ?? []), updatedAt: this.stored?.updatedAt ?? null,
      stale: !this.stored || !!this.error || this.now() - this.stored.updatedAt >= OPENCODE_FREE_CATALOGUE_TTL, ...(this.error ? { error: this.error } : {}) }
  }

  private async readCache() {
    if (!this.cachePath) return
    try {
      const raw = await readFile(this.cachePath, 'utf8')
      if (raw.length > 1024 * 1024) throw new Error('Oversized cache')
      const input = record(JSON.parse(raw))
      if (!input || input.version !== 1 || !positiveInteger(input.updatedAt) || input.updatedAt > this.now() || !Array.isArray(input.models) || input.models.length > 2000) throw new Error('Invalid cache')
      const models = input.models.map(value => {
        const model = record(value)
        if (!model || typeof model.apiModel !== 'string' || !MODEL_ID.test(model.apiModel) || model.id !== OPENCODE_FREE_MODEL_PREFIX + model.apiModel
          || typeof model.name !== 'string' || model.name.length > 120 || /[\x00-\x1f\x7f]/.test(model.name)
          || !positiveInteger(model.contextLimit) || !positiveInteger(model.outputLimit)
          || typeof model.sdk !== 'string' || !Object.hasOwn(PROTOCOLS, model.sdk) || model.protocol !== PROTOCOLS[model.sdk as OpenCodeModelSDK]
          || typeof model.toolCall !== 'boolean' || typeof model.vision !== 'boolean' || typeof model.reasoning !== 'boolean' || typeof model.temperature !== 'boolean'
          || (model.interleaved !== undefined && interleaved(model.interleaved) === undefined)) throw new Error('Invalid cached model')
        return { id: model.id as string, apiModel: model.apiModel, name: model.name, contextLimit: model.contextLimit, outputLimit: model.outputLimit,
          toolCall: model.toolCall, vision: model.vision, reasoning: model.reasoning, temperature: model.temperature,
          ...(model.interleaved === undefined ? {} : { interleaved: interleaved(model.interleaved) }),
          sdk: model.sdk as OpenCodeModelSDK, protocol: PROTOCOLS[model.sdk as OpenCodeModelSDK] }
      })
      this.stored = { models, updatedAt: input.updatedAt }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[OpenCode models] Ignoring invalid or unreadable catalogue cache')
    }
  }

  private async readJson(url: string): Promise<unknown> {
    const response = await this.request(url, { signal: AbortSignal.timeout(20_000), redirect: 'error', headers: { Accept: 'application/json' } })
    if (!response.ok) throw new OpenCodeModelError('OpenCode 官方模型目录请求失败（HTTP ' + response.status + '）。', 503)
    if (Number(response.headers.get('content-length')) > MAX_CATALOGUE_BYTES) throw new Error('Oversized catalogue')
    if (!response.body) throw new Error('Empty catalogue')
    const reader = response.body.getReader()
    let length = 0
    const chunks: Uint8Array[] = []
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        length += next.value.byteLength
        if (length > MAX_CATALOGUE_BYTES) { await reader.cancel(); throw new Error('Oversized catalogue') }
        chunks.push(next.value)
      }
    } finally { reader.releaseLock() }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }

  async get(forceRefresh = false): Promise<OpenCodeFreeCatalogue> {
    if (!this.loaded) {
      this.loading ??= this.readCache()
      await this.loading
      this.loaded = true
    }
    if (this.refreshing) return structuredClone(await this.refreshing)
    if (!forceRefresh && this.stored && !this.error && this.now() - this.stored.updatedAt < OPENCODE_FREE_CATALOGUE_TTL) return this.snapshot()
    if (!forceRefresh && this.lastAttempt !== null && this.now() - this.lastAttempt < RETRY_AFTER) return this.snapshot()
    this.lastAttempt = this.now()
    this.refreshing = (async () => {
      try {
        const [catalogue, live] = await Promise.all([this.readJson(OPENCODE_MODEL_CATALOGUE_URL), this.readJson(OPENCODE_INFERENCE_BASE_URL + '/models')])
        this.stored = { models: parseOpenCodeFreeModels(catalogue, live), updatedAt: this.now() }
        this.error = undefined
        if (this.cachePath) {
          try {
            await mkdir(path.dirname(this.cachePath), { recursive: true })
            const temp = this.cachePath + '.' + randomUUID() + '.tmp'
            await writeFile(temp, JSON.stringify({ version: 1, ...this.stored }), { encoding: 'utf8', mode: 0o600 })
            await rename(temp, this.cachePath)
          } catch { console.warn('[OpenCode models] Unable to persist catalogue cache') }
        }
      } catch (error) {
        this.error = error instanceof OpenCodeModelError ? error.message : '暂时无法刷新 OpenCode 免费模型目录，请检查网络后重试。'
      }
      return this.snapshot()
    })()
    try { return structuredClone(await this.refreshing) } finally { this.refreshing = null }
  }

  async resolve(model: string): Promise<OpenCodeFreeModel> {
    if (!isOpenCodeFreeModel(model) || !MODEL_ID.test(model.slice(OPENCODE_FREE_MODEL_PREFIX.length))) throw new OpenCodeModelError('无效的 OpenCode 免费模型标识。', 400)
    const catalogue = await this.get()
    if (catalogue.stale) throw new OpenCodeModelError(catalogue.error || 'OpenCode 免费模型目录已过期，请刷新后重试。', 503)
    const selected = catalogue.models.find(item => item.id === model)
    if (!selected) throw new OpenCodeModelError('该 OpenCode 模型已下线、取消免费或不支持当前聊天协议，请重新选择免费模型。', 404)
    return selected
  }
}

let catalogue = new OpenCodeFreeModelCatalogue()
/** Configure once at application startup; no account key or user conversation is cached. */
export function configureOpenCodeFreeModelCache(cachePath: string) { catalogue = new OpenCodeFreeModelCatalogue({ cachePath }) }
export function getOpenCodeFreeModels(forceRefresh = false) { return catalogue.get(forceRefresh) }
export function resolveOpenCodeFreeModel(model: string) { return catalogue.resolve(model) }
export async function resolveNativeModel(model: string) { return (await resolveOpenCodeFreeModel(model)).apiModel }
