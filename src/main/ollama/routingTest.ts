import { randomUUID } from 'node:crypto'
import { dispatchChatCompletion } from '../proxy/dispatch'
import { storeManager } from '../store/store'
import { freeModelSource } from '../../shared/freeModels'
import { redactSecrets } from '../../shared/redaction'
import type { OllamaRoutingTestResult } from '../../shared/types'

/** Exercise the saved API routing policy, including node selection and free transports. */
export async function testOllamaRouting(requestedModel: unknown): Promise<OllamaRoutingTestResult> {
  if (typeof requestedModel !== 'string' || !requestedModel.trim() || requestedModel.length > 512) {
    throw new Error('Enter a request model between 1 and 512 characters / 请输入 1–512 字符的请求模型名')
  }
  const model = requestedModel.trim()
  const started = Date.now()
  const config = storeManager.getConfig()
  const routedModel = config.ollamaRouting?.forceModel ? config.ollamaRouting.model : model
  const timeout = Math.max(1000, Math.min(config.requestTimeout || 60_000, 120_000))
  const signal = AbortSignal.timeout(timeout)
  try {
    // No explicit-model header: the test must honor exactly the same policy as API clients.
    const dispatched = await dispatchChatCompletion({
      model, messages: [{ role: 'user', content: 'Reply briefly with OK.' }], stream: false, max_tokens: 64,
    }, `routing-test-${randomUUID()}`, '127.0.0.1', {}, signal)
    const { result, selection } = dispatched
    const actualModel = selection?.actualModel || dispatched.routedModel || routedModel
    const content = result.body?.choices?.[0]?.message?.content
    const response = typeof content === 'string' ? content.trim().slice(0, 500) : ''
    const success = result.success && Boolean(response)
    return {
      success, requestedModel: model, routedModel: actualModel,
      providerName: selection?.provider.name || freeModelSource(actualModel)?.name,
      latency: Date.now() - started,
      ...(success ? { response } : { error: String(redactSecrets(signal.aborted
        ? 'Routing test timed out / 路由测试超时'
        : result.error || 'The upstream returned no answer / 上游未返回回答')) }),
    }
  } catch (error) {
    const message = String(redactSecrets(signal.aborted ? 'Routing test timed out / 路由测试超时' : error instanceof Error ? error.message : String(error)))
    storeManager.addLog('error', `Routing test failed: ${message}`, { model })
    return { success: false, requestedModel: model, routedModel, latency: Date.now() - started, error: message }
  }
}
