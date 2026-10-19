import { setTimeout as delay } from 'node:timers/promises'
import { loadBalancer } from './loadbalancer'
import { modelMapper } from './modelMapper'
import { requestForwarder } from './forwarder'
import { storeManager } from '../store/store'
import { proxyStatusManager } from './status'
import { resolveOllamaRouting } from '../ollama/routing'
import { extractTokenCount } from './tokenUsage'
import type { ChatCompletionRequest, ForwardResult, AccountSelection, ProxyContext } from './types'
import { ModelFeatureError, normalizeFeatureRequest } from './modelFeatures'
import { openCodeAffinityKey, openCodeSessionAffinity } from './sessionAffinity'
import { isTransportFailure, sameAccountRetryDelay } from './upstreamFailure'

export interface DispatchResult {
  selection?: AccountSelection
  result: ForwardResult
  finishStream?: (error?: Error) => void
}

/** Failures another account (or a later attempt) may not repeat. 400-class input errors never retry. */
const retryable = (status?: number) => status === undefined || [401, 403, 408, 429].includes(status) || status >= 500
/** Credential failures are specific to an account, so only a different account can help. */
const sameAccountRetryable = (status?: number) => status === undefined || status === 408 || status === 429 || status >= 500

export async function dispatchChatCompletion(
  request: ChatCompletionRequest,
  requestId: string,
  clientIP?: string,
  headers: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<DispatchResult> {
  const config = storeManager.getConfig()
  try {
    request = normalizeFeatureRequest(request, { ...config.modelFeatureDefaults, thinking: 'auto' }, headers)
  } catch (error) {
    if (error instanceof ModelFeatureError) return { result: { success: false, status: 400, error: error.message } }
    throw error
  }
  const routing = resolveOllamaRouting(request.model, config.ollamaRouting, headers['x-dailyworkmate-model-selection'] === 'explicit')
  if (routing.error) return { result: { success: false, status: 503, error: routing.error } }
  const modelPin = modelMapper.getPreferredProvider(routing.model)
  if (routing.preferredProviderId && modelPin && routing.preferredProviderId !== modelPin) return { result: { success: false, status: 400, error: '固定节点规则冲突，请在 Ollama 页面取消模型固定或调整全局固定节点。 / Node pin rules conflict. Unpin the model or change the global fixed node on the Ollama page.' } }
  const preferredProviderId = routing.ollamaOnly
    ? routing.preferredProviderId
    : modelMapper.getPreferredProvider(routing.model)
  const affinityKey = openCodeAffinityKey(headers, routing.model)
  const preferredAccountId = routing.ollamaOnly ? undefined : modelMapper.getPreferredAccount(routing.model)
  const initialSelection = loadBalancer.selectAccount(
    routing.model,
    config.loadBalanceStrategy,
    preferredProviderId,
    preferredAccountId || openCodeSessionAffinity.get(affinityKey),
    routing.ollamaOnly ? 'ollama' : undefined,
  )
  if (!initialSelection) {
    return {
      result: {
        success: false,
        status: 503,
        error: preferredProviderId
          ? `Strictly pinned provider ${preferredProviderId} is unavailable for model: ${routing.model}`
          : routing.ollamaOnly
            ? `No available Ollama account for model: ${routing.model}. Check the node connection, authentication and installed models.`
            : `No available account for model: ${routing.model}. Check the provider, account credentials and quota.`,
      },
    }
  }

  request = normalizeFeatureRequest(request, { ...config.modelFeatureDefaults, thinking: ['perplexity', 'minimax'].includes(initialSelection.provider.id) ? 'auto' : config.modelFeatureDefaults.thinking }, headers)
  let selection = initialSelection
  const startTime = Date.now()
  const context: ProxyContext = {
    requestId,
    providerId: selection.provider.id,
    accountId: selection.account.id,
    model: request.model,
    actualModel: selection.actualModel,
    startTime,
    isStream: Boolean(request.stream),
    clientIP,
    signal,
  }
  proxyStatusManager.recordRequestStart(request.model, selection.provider.id, selection.account.id)

  try {
    // Actual requests determine availability. Do not gate inference on a marker-echo test.
    // The forwarder makes exactly one attempt; this loop owns the single retry budget.
    const forward = (): Promise<ForwardResult> => requestForwarder.forwardChatCompletion(
      request,
      selection.account,
      selection.provider,
      selection.actualModel,
      { ...context, providerId: selection.provider.id, accountId: selection.account.id, actualModel: selection.actualModel },
    )
    let result = await forward()
    let attemptedAccounts: string[] = [selection.account.id]
    let attempts = 1
    while (!result.success && !signal?.aborted && retryable(result.status)) {
      openCodeSessionAffinity.forget(affinityKey, selection.account.id)
      const ollama = selection.provider.upstreamKind === 'ollama'
      // Only an unreachable or silent node is quarantined at once. An HTTP 5xx can be caused by the
      // request itself (out of memory, context too long), so it only counts toward the threshold.
      loadBalancer.markAccountFailed(selection.account.id, ollama && isTransportFailure(result))
      if (attempts > config.retryCount) break
      const next = loadBalancer.selectAccount(
        routing.model, config.loadBalanceStrategy, preferredProviderId,
        routing.ollamaOnly ? undefined : modelMapper.getPreferredAccount(routing.model),
        ollama ? 'ollama' : undefined, attemptedAccounts,
      )
      let wait = 0
      if (next) {
        selection = next
        attemptedAccounts = [...attemptedAccounts, next.account.id]
      } else {
        // No other account. Retrying the same Ollama endpoint repeats a dead node, and a
        // credential error or a long Retry-After will not clear within this request.
        const retryDelay = ollama || !sameAccountRetryable(result.status)
          ? undefined : sameAccountRetryDelay(result, proxyStatusManager.getConfig().retryDelay)
        if (retryDelay === undefined) break
        wait = retryDelay
      }
      storeManager.addLog('warn', next ? 'Account failed; trying another account for the same model' : 'Request failed; retrying the same account', {
        requestId, providerId: selection.provider.id,
        model: request.model, error: result.error,
        data: { nextProviderId: selection.provider.id, status: result.status, waitMs: wait },
      })
      if (wait > 0) {
        try { await delay(wait, undefined, { signal }) } catch {
          result = { success: false, status: 499, error: 'Client cancelled the request' }
          break
        }
      }
      attempts += 1
      result = await forward()
    }
    const latency = Date.now() - startTime

    if (!result.success) {
      // Every failed attempt was already counted in the loop; counting again would quarantine early.
      openCodeSessionAffinity.forget(affinityKey, selection.account.id)
      proxyStatusManager.recordRequestFailure(latency)
      storeManager.addLog('error', `Request failed: ${result.error || 'Unknown error'}`, {
        requestId,
        providerId: selection.provider.id,
        accountId: selection.account.id,
        model: request.model,
        actualModel: selection.actualModel,
        latency,
      })
      storeManager.recordRequestInStats(
        false,
        latency,
        request.model,
        selection.provider.id,
        selection.account.id,
      )
      return { selection, result: { ...result, error: `${selection.provider.name}: ${result.error || 'Request failed'}${attemptedAccounts.length > 1 ? ` (${attemptedAccounts.length} nodes attempted)` : attempts > 1 ? ` (${attempts} attempts)` : ''}` } }
    }

    let finished = false
    const finish = (error?: Error) => {
      if (finished) return
      finished = true
      const elapsed = Date.now() - startTime
      if (error) {
        openCodeSessionAffinity.forget(affinityKey, selection.account.id)
        proxyStatusManager.recordRequestFailure(elapsed)
        if (!signal?.aborted) loadBalancer.markAccountFailed(selection.account.id)
      } else {
        const ollama = selection.provider.upstreamKind === 'ollama'
        if (ollama) openCodeSessionAffinity.remember(affinityKey, selection.account.id)
        loadBalancer.clearAccountFailure(selection.account.id)
        proxyStatusManager.recordRequestSuccess(elapsed)
        // Counters are buffered in memory; only an actual status change is written right away.
        storeManager.recordAccountUsage(selection.account.id, { reactivate: ollama })
        if (ollama && (selection.provider.status !== 'online' || selection.provider.lastScanError)) {
          storeManager.updateProvider(selection.provider.id, { status: 'online', lastScanError: undefined, lastStatusCheck: Date.now() })
        }
      }
      storeManager.addLog(error ? 'error' : 'debug', error ? `Stream failed: ${error.message}` : 'Request succeeded', {
        requestId, providerId: selection.provider.id, accountId: selection.account.id,
        model: request.model, actualModel: selection.actualModel, latency: elapsed, isStream: request.stream,
      })
      storeManager.recordRequestInStats(!error, elapsed, request.model, selection.provider.id, selection.account.id)
    }
    if (request.stream === true && result.stream) return { selection, result, finishStream: finish }
    finish()
    storeManager.recordTokenUsage(request.model, extractTokenCount(result.body))
    return { selection, result }
  } catch (error) {
    openCodeSessionAffinity.forget(affinityKey, selection.account.id)
    const latency = Date.now() - startTime
    proxyStatusManager.recordRequestFailure(latency)
    if (!signal?.aborted) loadBalancer.markAccountFailed(selection.account.id)
    const message = error instanceof Error ? error.message : String(error)
    storeManager.addLog('error', `Request failed: ${message}`, {
      requestId,
      providerId: selection.provider.id,
      accountId: selection.account.id,
      model: request.model,
      actualModel: selection.actualModel,
      latency,
    })
    storeManager.recordRequestInStats(
      false,
      latency,
      request.model,
      selection.provider.id,
      selection.account.id,
    )
    return { selection, result: { success: false, status: 500, error: message } }
  }
}
