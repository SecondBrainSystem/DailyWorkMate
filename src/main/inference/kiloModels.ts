import { KILO_FREE_PREFIX, isKiloFreeModel, type KiloFreeCatalogue, type KiloFreeModel } from '../../shared/freeModels.ts'

export const KILO_BASE_URL = 'https://api.kilo.ai/api/gateway'
export const KILO_CATALOGUE_TTL = 15 * 60_000
const RETRY_DELAY = 30_000
const MAX_JSON_BYTES = 16 * 1024 * 1024
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,239}$/

export class KiloModelError extends Error {
  readonly status: number
  constructor(message: string, status = 503) {
    super(message); this.name = 'KiloModelError'
    this.status = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502
  }
}

/** Stop a caller's wait without aborting a catalogue refresh shared by other windows. */
export async function waitForKiloOperation<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation
  signal.throwIfAborted()
  let abort!: () => void
  const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(signal.reason || new Error('Kilo request cancelled')) })
  signal.addEventListener('abort', abort, { once: true })
  try { return await Promise.race([operation, cancelled]) } finally { signal.removeEventListener('abort', abort) }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
export function validKiloModelId(id: string): boolean { return MODEL_ID.test(id) && !id.split('/').some(part => !part || part === '.' || part === '..') }

/** isFree is authoritative. A free-looking name or zero price alone is insufficient. */
export function parseKiloFreeModels(payload: unknown): KiloFreeModel[] {
  const rows = record(payload)?.data
  if (!Array.isArray(rows)) throw new KiloModelError('Kilo 免费模型目录格式不正确。 / Invalid Kilo model catalogue.')
  const models = rows.flatMap((value): KiloFreeModel[] => {
    const row = record(value), architecture = record(row?.architecture), provider = record(row?.top_provider)
    if (!row || row.isFree !== true || typeof row.id !== 'string' || !validKiloModelId(row.id)) return []
    const pricing = record(row.pricing)
    // Reject contradictory pricing instead of risking a paid request.
    if (pricing && Object.values(pricing).some(price => (typeof price !== 'string' && typeof price !== 'number') || String(price).trim() === '' || Number(price) !== 0)) return []
    if (!Array.isArray(architecture?.input_modalities) || !architecture.input_modalities.includes('text')
      || !Array.isArray(architecture.output_modalities) || !architecture.output_modalities.includes('text')) return []
    const parameters = Array.isArray(row.supported_parameters) ? row.supported_parameters.filter((p): p is string => typeof p === 'string') : []
    const context = positive(row.context_length) ? row.context_length : provider?.context_length
    const output = provider?.max_completion_tokens
    if (!positive(context)) return []
    const name = typeof row.name === 'string' && row.name.length <= 160 && !/[\x00-\x1f\x7f]/.test(row.name) ? row.name : row.id
    return [{ id: KILO_FREE_PREFIX + row.id, apiModel: row.id, name, contextLimit: context,
      outputLimit: positive(output) ? output : Math.min(context, 32768), toolCall: parameters.includes('tools'),
      vision: architecture.input_modalities.includes('image'), reasoning: parameters.includes('reasoning'), parameters }]
  })
  return [...new Map(models.map(model => [model.id, model])).values()].sort((a, b) => a.name.localeCompare(b.name))
}

export async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new KiloModelError('Kilo 返回空响应。 / Empty Kilo response.')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > MAX_JSON_BYTES) throw new KiloModelError('Kilo response exceeds 16 MiB')
      chunks.push(next.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally { try { await reader.cancel() } finally { reader.releaseLock() } }
}

export class KiloFreeModelCatalogue {
  private stored: KiloFreeCatalogue = { models: [], updatedAt: null, stale: true }
  private pending?: Promise<KiloFreeCatalogue>
  private lastAttempt = -Infinity
  constructor(private readonly request: typeof fetch = fetch, private readonly now: () => number = Date.now) {}

  async get(force = false): Promise<KiloFreeCatalogue> {
    if (this.pending) return structuredClone(await this.pending)
    const expired = this.stored.updatedAt === null || this.now() - this.stored.updatedAt >= KILO_CATALOGUE_TTL
    if (!force && ((!expired && !this.stored.error) || this.now() - this.lastAttempt < RETRY_DELAY)) return structuredClone({ ...this.stored, stale: expired || !!this.stored.error })
    this.lastAttempt = this.now()
    this.pending = (async () => {
      try {
        const response = await this.request(KILO_BASE_URL + '/models', { headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15_000) })
        if (!response.ok) { await response.body?.cancel(); throw new KiloModelError('Kilo 模型目录请求失败 / Catalogue request failed (HTTP ' + response.status + ')') }
        this.stored = { models: parseKiloFreeModels(await readBoundedJson(response)), updatedAt: this.now(), stale: false }
      } catch (error) {
        const message = error instanceof KiloModelError ? error.message : '无法刷新 Kilo 免费模型，请检查网络后重试。 / Could not refresh Kilo free models. Check your connection and retry.'
        console.warn('[Kilo models]', message)
        this.stored = { ...this.stored, stale: true, error: message }
      }
      return this.stored
    })()
    try { return structuredClone(await this.pending) } finally { this.pending = undefined }
  }

  async resolve(id: string, signal?: AbortSignal): Promise<KiloFreeModel> {
    if (!isKiloFreeModel(id) || !validKiloModelId(id.slice(KILO_FREE_PREFIX.length))) throw new KiloModelError('Invalid Kilo free model ID', 400)
    const catalogue = await waitForKiloOperation(this.get(), signal)
    if (catalogue.stale) throw new KiloModelError(catalogue.error || 'Kilo 免费模型目录已过期，请刷新。 / Refresh the expired Kilo catalogue.')
    const model = catalogue.models.find(model => model.id === id)
    if (!model) throw new KiloModelError('该 Kilo 模型已下线或不再免费，请刷新并重新选择。 / This Kilo model is unavailable or no longer free. Refresh and select another model.', 404)
    return model
  }
}

export const kiloFreeModels = new KiloFreeModelCatalogue()
