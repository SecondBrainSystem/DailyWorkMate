import { createHash, randomBytes } from 'node:crypto'
import { OllamaAdapter } from './adapters/ollama'
import type { AccountSelection, ForwardResult } from './types'

export interface OllamaQualityResult {
  success: boolean
  status?: number
  error?: string
  errorCode?: string
  verifiedAt?: number
}

interface CachedQuality {
  result: OllamaQualityResult
  expiresAt: number
}

interface PendingQuality {
  controller: AbortController
  promise: Promise<OllamaQualityResult>
  subscribers: Set<symbol>
}

const cancelled = (): OllamaQualityResult => ({ success: false, status: 499, error: 'Model verification cancelled' })
const identity = (selection: AccountSelection): string => {
  const { account, provider, actualModel } = selection
  const sorted = (value: Record<string, string> = {}) => Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
  // Credentials affect cache validity, but are never retained in a key or logged.
  return createHash('sha256').update(JSON.stringify([
    provider.id, provider.apiEndpoint, actualModel, provider.ollamaModels?.[actualModel]?.endpoint,
    sorted(provider.headers), account.id, sorted(account.credentials),
  ])).digest('hex')
}

/** Shape-only discovery cannot distinguish real inference from canned HTTP 200 replies. */
export class OllamaQualityVerifier {
  private cache = new Map<string, CachedQuality>()
  private pending = new Map<string, PendingQuality>()

  constructor(
    private readonly forward: typeof OllamaAdapter.forward = (...args) => OllamaAdapter.forward(...args),
    private readonly now = Date.now,
  ) {}

  peek(selection: AccountSelection): OllamaQualityResult | undefined {
    const key = identity(selection)
    const entry = this.cache.get(key)
    if (entry && entry.expiresAt > this.now()) return entry.result
    this.cache.delete(key)
    return undefined
  }

  clear(): void { this.cache.clear() }

  async verify(selection: AccountSelection, timeout: number, signal?: AbortSignal): Promise<OllamaQualityResult> {
    if (signal?.aborted) return cancelled()
    if (selection.provider.upstreamKind !== 'ollama') return { success: true }
    const cached = this.peek(selection)
    if (cached) return cached
    const key = identity(selection)
    let pending = this.pending.get(key)
    if (!pending) {
      const controller = new AbortController()
      const promise = this.challenge(selection, timeout, controller.signal).then(result => {
        if (result.status !== 499 && !controller.signal.aborted) {
          // Refresh successful nodes every half hour; failed nodes remain explicitly retryable.
          this.cache.set(key, { result, expiresAt: this.now() + (result.success ? 30 * 60_000 : 2 * 60_000) })
          if (this.cache.size > 2048) this.cache.delete(this.cache.keys().next().value!)
        }
        return result
      }).finally(() => { if (this.pending.get(key)?.controller === controller) this.pending.delete(key) })
      pending = { controller, promise, subscribers: new Set() }
      this.pending.set(key, pending)
    }
    const current = pending
    const subscriber = Symbol()
    this.pending.set(key, { ...current, subscribers: new Set([...current.subscribers, subscriber]) })
    return new Promise(resolve => {
      let finished = false
      const finish = (result: OllamaQualityResult) => {
        if (finished) return
        finished = true
        signal?.removeEventListener('abort', abort)
        const latest = this.pending.get(key)
        if (latest?.controller === current.controller) {
          const subscribers = new Set([...latest.subscribers].filter(item => item !== subscriber))
          this.pending.set(key, { ...latest, subscribers })
          if (subscribers.size === 0 && result.status === 499) {
            this.pending.delete(key)
            current.controller.abort()
          }
        }
        resolve(result)
      }
      const abort = () => finish(cancelled())
      signal?.addEventListener('abort', abort, { once: true })
      void current.promise.then(finish, () => finish({ success: false, status: 502, error: 'Model verification failed', errorCode: 'ollama_verification_failed' }))
      if (signal?.aborted) abort()
    })
  }

  private async challenge(selection: AccountSelection, timeout: number, signal: AbortSignal): Promise<OllamaQualityResult> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const marker = `VERIFY_${randomBytes(16).toString('hex')}`
      const prompt = attempt === 0
        ? `Reply with exactly this text, without explanations: ${marker}`
        : `请原样输出以下标识，不要解释或添加其他内容：${marker}`
      const result: ForwardResult = await this.forward({
        model: selection.actualModel, messages: [{ role: 'user', content: prompt }],
        stream: false, max_tokens: 512, temperature: 0,
      }, selection.account, selection.provider, selection.actualModel, Math.min(Math.max(timeout, 1000), 300_000), signal)
      if (signal.aborted || result.status === 499) return cancelled()
      if (!result.success) return {
        success: false, status: result.status || 502, errorCode: 'ollama_verification_failed',
        error: `节点内容验证未完成：${result.error || '上游请求失败'}。未向此节点发送正文。`,
      }
      const content = result.body?.choices?.[0]?.message?.content
      if (typeof content === 'string' && content.includes(marker)) return { success: true, verifiedAt: this.now() }
    }
    return {
      success: false, status: 503, errorCode: 'ollama_quality_failed',
      error: '节点连续两次未能按指令返回随机验证标识，可能正在返回无关套话，已暂时隔离 2 分钟。未向此节点发送正文；这不是上下文长度限制。',
    }
  }
}

export const ollamaQuality = new OllamaQualityVerifier()
