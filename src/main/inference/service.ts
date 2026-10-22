import { randomUUID } from 'node:crypto'
import type { Readable } from 'node:stream'
import type { InternalInferenceRequest, InternalInferenceResponse } from '../../shared/inference'
import type { ChatCompletionRequest } from '../proxy/types'
import { dispatchChatCompletion } from '../proxy/dispatch'
import { listInferenceModels } from './modelListing'
import { verifyModelSelection } from '../proxy/modelVerification'
import { ModelFeatureError, normalizeFeatureRequest } from '../proxy/modelFeatures'
import { streamHandler } from '../proxy/stream'
import { relayResponseStream } from '../proxy/responseStream'
import { extractTokenCount } from '../proxy/tokenUsage'
import { isAnthropicToolFormat, transformResponseToAnthropic } from '../proxy/utils/toolFormatConverter'
import { storeManager } from '../store/store'
import { freeModelSource } from '../../shared/freeModels'

const MAX_REQUEST_BYTES = 50 * 1024 * 1024
const allowedHeaders = new Set([
  'content-type', 'x-enable-thinking', 'x-enable-vision', 'x-reasoning-effort',
  'x-web-search', 'x-deep-research', 'x-dailyworkmate-model-selection', 'x-opencode-session', 'x-refresh-free-models',
])
const jsonHeaders = { 'content-type': 'application/json' }

export function validateInferenceId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(id)) throw new Error('Invalid inference request ID')
}

/** Only the three desktop operations are accepted; arbitrary URLs and upstream credentials are never forwarded. */
export function validateInferenceRequest(input: unknown): InternalInferenceRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid inference request')
  const request = input as InternalInferenceRequest
  validateInferenceId(request.id)
  if (!['/v1/models', '/v1/models/verify', '/v1/chat/completions'].includes(request.path)) throw new Error('Unsupported inference operation')
  const method = request.path === '/v1/models' ? 'GET' : 'POST'
  if (request.method !== undefined && request.method !== method) throw new Error('Unsupported inference method')
  if (request.headers !== undefined && (!request.headers || typeof request.headers !== 'object' || Array.isArray(request.headers))) throw new Error('Invalid inference headers')
  const headers = Object.fromEntries(Object.entries(request.headers || {}).map(([key, value]) => {
    const normalized = key.toLowerCase()
    if (!allowedHeaders.has(normalized) || typeof value !== 'string' || value.length > 4096 || /[\r\n]/.test(value)) throw new Error('Unsupported inference header')
    return [normalized, value]
  }))
  let body = request.body
  if (body !== undefined) {
    const encoded = typeof body === 'string' ? body : JSON.stringify(body)
    if (typeof encoded !== 'string' || Buffer.byteLength(encoded, 'utf8') > MAX_REQUEST_BYTES) throw new Error('Inference request body exceeds 50 MB')
    if (typeof body === 'string') {
      try { body = JSON.parse(body) } catch { throw new Error('Inference request body must contain valid JSON') }
    }
  }
  if (method === 'GET' && body !== undefined) throw new Error('Model listing does not accept a request body')
  return { id: request.id, path: request.path, method, headers, ...(body === undefined ? {} : { body }) }
}

export interface InternalInferenceResult {
  response: InternalInferenceResponse
  output?: Readable
}

function failure(status: number, message: string, code = 'invalid_request', param: string | null = null): InternalInferenceResult {
  return { response: { status, headers: jsonHeaders, body: { error: { message, type: status < 500 ? 'invalid_request_error' : 'api_error', code, param } } } }
}

function extractUserInput(request: ChatCompletionRequest): string | undefined {
  const message = request.messages.findLast(message => message.role === 'user')
  if (typeof message?.content === 'string') return message.content
  return message?.content?.filter(part => part.type === 'text').map(part => part.text || '').join(' ') || undefined
}

/** Reuses account selection and adapters directly, independently of public proxy listeners. */
export async function executeInternalInference(input: InternalInferenceRequest, signal: AbortSignal): Promise<InternalInferenceResult> {
  const validated = validateInferenceRequest(input)
  // Desktop users choose their model explicitly; public API routing defaults cannot replace it.
  const checked: InternalInferenceRequest = { ...validated, headers: { ...validated.headers, 'x-dailyworkmate-model-selection': 'explicit' } }
  if (signal.aborted) return failure(499, 'Inference request cancelled', 'request_cancelled')
  if (checked.path === '/v1/models') {
    const body = await listInferenceModels(checked.headers?.['x-refresh-free-models'] === 'true', signal)
    if (signal.aborted) return failure(499, 'Inference request cancelled', 'request_cancelled')
    return { response: { status: 200, headers: jsonHeaders, body } }
  }
  if (checked.path === '/v1/models/verify') {
    const body = checked.body as { model?: unknown; recover?: unknown } | undefined
    if (!body || typeof body.model !== 'string' || !body.model.trim() || body.model.length > 512
      || (body.recover !== undefined && typeof body.recover !== 'boolean')) return failure(400, 'A model and optional boolean recover are required')
    const result = await verifyModelSelection(body.model.trim(), body.recover === true, signal)
    return result.success ? { response: { status: 200, headers: jsonHeaders, body: result.value } }
      : failure(result.result.status || 503, result.result.error, result.result.errorCode || 'model_verification_failed')
  }

  const startTime = Date.now()
  const requestId = `desktop-${randomUUID()}`
  let request: ChatCompletionRequest
  const config = storeManager.getConfig()
  try {
    const body = checked.body as ChatCompletionRequest
    // Fold header switches in before normalizing so dispatch reuses this normalized request.
    const withHeaders = body && typeof body === 'object' && !Array.isArray(body) ? {
      ...body,
      ...(body.web_search === undefined && checked.headers?.['x-web-search'] !== undefined ? { web_search: checked.headers['x-web-search'] === 'true' } : {}),
      ...(body.deep_research === undefined && checked.headers?.['x-deep-research'] !== undefined ? { deep_research: checked.headers['x-deep-research'] === 'true' } : {}),
    } : body
    request = normalizeFeatureRequest(withHeaders, { ...config.modelFeatureDefaults, thinking: 'auto' }, checked.headers)
  } catch (error) {
    return failure(400, error instanceof ModelFeatureError ? error.message : 'Invalid request body', 'invalid_request', error instanceof ModelFeatureError ? error.param : null)
  }
  const dispatched = await dispatchChatCompletion(request, requestId, 'desktop', checked.headers, signal)
  const { result, selection } = dispatched
  const actualModel = selection?.actualModel || (freeModelSource(request.model)?.apiModel || request.model)
  const errorResponse = failure(result.status || 500, result.error || 'Request failed', result.errorCode || 'api_error')
  const responseBody = result.success
    ? !request.stream && isAnthropicToolFormat(request.tool_format) ? transformResponseToAnthropic(result.body) : result.body
    : errorResponse.response.body
  // Bodies can be up to 50MB; serialize them only when request logging keeps bodies.
  const keepBodies = Boolean(config.requestLogConfig?.enabled && config.requestLogConfig.includeBodies)
  const log = storeManager.addRequestLog({
    timestamp: startTime, status: result.success ? 'success' : 'error', statusCode: result.success ? 200 : result.status || 500,
    method: 'POST', url: '/v1/chat/completions', model: request.model, actualModel,
    providerId: selection?.provider.id || freeModelSource(request.model)?.id, providerName: selection?.provider.name || freeModelSource(request.model)?.name,
    accountId: selection?.account.id, accountName: selection?.account.name,
    requestBody: keepBodies ? JSON.stringify(request) : undefined, userInput: extractUserInput(request),
    webSearch: request.web_search, reasoningEffort: request.reasoning_effort,
    responseStatus: result.success ? 200 : result.status || 500,
    responseBody: !result.success || (!request.stream && keepBodies) ? JSON.stringify(responseBody) : undefined,
    latency: Date.now() - startTime, isStream: Boolean(request.stream), errorMessage: result.error,
  })
  if (!result.success) return errorResponse
  if (!request.stream || !result.stream) return { response: { status: 200, headers: jsonHeaders, body: responseBody } }

  const transforms = result.skipTransform ? [] : [streamHandler.createTransformStream(actualModel, requestId)]
  const output = relayResponseStream(result.stream, transforms, 'openai', (error, body) => {
    dispatched.finishStream?.(error)
    storeManager.recordTokenUsage(request.model, extractTokenCount(body))
    if (log) storeManager.updateRequestLog(log.id, {
      status: error ? 'error' : 'success', responseBody: body || undefined,
      errorMessage: error?.message, latency: Date.now() - startTime,
    })
  }, { maxBodyChars: keepBodies ? config.requestLogConfig.maxBodyChars : 0 })
  const abort = () => output.destroy(new Error('Client cancelled the request'))
  // Cancellation may arrive while dispatch is still waiting for the first token.
  output.on('error', () => {}) // Keep an early abort safe until IPC attaches its stream consumer.
  signal.addEventListener('abort', abort, { once: true })
  output.once('close', () => signal.removeEventListener('abort', abort))
  if (signal.aborted) abort()
  return { response: { status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }, stream: true }, output }
}
