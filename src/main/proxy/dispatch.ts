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

export interface DispatchResult {
  selection?: AccountSelection
  result: ForwardResult
  finishStream?: (error?: Error) => void
}

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
    const forward = async (): Promise<ForwardResult> => {
      // Actual requests determine availability. Do not gate inference on a marker-echo test.
      return requestForwarder.forwardChatCompletion(
      request,
      selection.account,
      selection.provider,
      selection.actualModel,
      { ...context, providerId: selection.provider.id, accountId: selection.account.id, actualModel: selection.actualModel },
      // Ollama retries must select another eligible node, not repeat a dead endpoint.
      selection.provider.upstreamKind === 'ollama' ? 0 : undefined,
      )
    }
    let result = await forward()
    let attemptedAccounts: string[] = [selection.account.id]
    const retryable = (status?: number) => status === undefined || [401, 403, 408, 429].includes(status) || status >= 500
    while (!result.success && !signal?.aborted && (selection.provider.upstreamKind === 'ollama' || config.loadBalanceStrategy === 'failover') && retryable(result.status)) {
      openCodeSessionAffinity.forget(affinityKey, selection.account.id)
      loadBalancer.markAccountFailed(selection.account.id, selection.provider.upstreamKind === 'ollama')
      if (attemptedAccounts.length > config.retryCount) break
      const next = loadBalancer.selectAccount(
        routing.model, config.loadBalanceStrategy, preferredProviderId,
        routing.ollamaOnly ? undefined : modelMapper.getPreferredAccount(routing.model),
        selection.provider.upstreamKind === 'ollama' ? 'ollama' : undefined, attemptedAccounts,
      )
      if (!next) break
      storeManager.addLog('warn', 'Account failed; trying another account for the same model', {
        requestId, providerId: selection.provider.id,
        model: request.model, error: result.error,
        data: { nextProviderId: next.provider.id, status: result.status },
      })
      selection = next
      attemptedAccounts = [...attemptedAccounts, next.account.id]
      result = await forward()
    }
    const latency = Date.now() - startTime

    if (!result.success) {
      openCodeSessionAffinity.forget(affinityKey, selection.account.id)
      proxyStatusManager.recordRequestFailure(latency)
      if (!signal?.aborted && selection.provider.upstreamKind !== 'ollama' && retryable(result.status)) {
        loadBalancer.markAccountFailed(selection.account.id)
      }
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
      return { selection, result: { ...result, error: `${selection.provider.name}: ${result.error || 'Request failed'}${attemptedAccounts.length > 1 ? ` (${attemptedAccounts.length} nodes attempted)` : ''}` } }
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
        if (selection.provider.upstreamKind === 'ollama') openCodeSessionAffinity.remember(affinityKey, selection.account.id)
        loadBalancer.clearAccountFailure(selection.account.id)
        proxyStatusManager.recordRequestSuccess(elapsed)
        const current = storeManager.getAccountById(selection.account.id)
        if (current) storeManager.updateAccount(current.id, {
          ...(selection.provider.upstreamKind === 'ollama' ? { status: 'active' as const, errorMessage: undefined } : {}),
          lastUsed: Date.now(), requestCount: (current.requestCount || 0) + 1, todayUsed: (current.todayUsed || 0) + 1,
        })
        if (selection.provider.upstreamKind === 'ollama') storeManager.updateProvider?.(selection.provider.id, { status: 'online', lastScanError: undefined, lastStatusCheck: Date.now() })
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
