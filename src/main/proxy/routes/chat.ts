import Router from '@koa/router'
import type { Context } from 'koa'
import type { ChatCompletionRequest } from '../types'
import { dispatchChatCompletion } from '../dispatch'
import { streamHandler } from '../stream'
import { extractTokenCount } from '../tokenUsage'
import { storeManager } from '../../store/store'
import { ModelFeatureError, normalizeFeatureRequest } from '../modelFeatures'
import { clientAbortSignal, relayResponseStream } from '../responseStream'
import { isAnthropicToolFormat, transformResponseToAnthropic } from '../utils/toolFormatConverter'

const router = new Router({ prefix: '/v1/chat' })

function extractUserInput(request: ChatCompletionRequest): string | undefined {
  const message = request.messages.findLast(message => message.role === 'user')
  if (typeof message?.content === 'string') return message.content
  return message?.content?.filter(part => part.type === 'text').map(part => part.text || '').join(' ') || undefined
}

router.post('/completions', async (ctx: Context) => {
  const startTime = Date.now()
  const requestId = `chatcmpl-${startTime.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  let request: ChatCompletionRequest
  try {
    request = normalizeFeatureRequest(ctx.request.body as ChatCompletionRequest, { ...storeManager.getConfig().modelFeatureDefaults, thinking: 'auto' }, ctx.headers)
  } catch (error) {
    ctx.status = 400
    ctx.body = { error: {
      message: error instanceof ModelFeatureError ? error.message : 'Invalid request body',
      type: 'invalid_request_error', param: error instanceof ModelFeatureError ? error.param : null, code: null,
    } }
    return
  }
  request = {
    ...request,
    ...(request.web_search === undefined && ctx.headers['x-web-search'] !== undefined
      ? { web_search: ctx.headers['x-web-search'] === 'true' } : {}),
    ...(request.deep_research === undefined && ctx.headers['x-deep-research'] !== undefined
      ? { deep_research: ctx.headers['x-deep-research'] === 'true' } : {}),
  }

  const signal = clientAbortSignal(ctx)
  const dispatched = await dispatchChatCompletion(request, requestId, ctx.ip, ctx.headers, signal)
  const { result, selection } = dispatched
  const actualModel = selection?.actualModel || request.model
  const latency = Date.now() - startTime
  const errorBody = { error: { message: result.error || 'Request failed', type: 'api_error', param: null, code: result.errorCode || null } }
  const log = selection ? storeManager.addRequestLog({
    timestamp: startTime,
    status: result.success ? 'success' : 'error',
    statusCode: result.success ? 200 : result.status || 500,
    method: 'POST', url: '/v1/chat/completions', model: request.model, actualModel,
    providerId: selection.provider.id, providerName: selection.provider.name,
    accountId: selection.account.id, accountName: selection.account.name,
    requestBody: JSON.stringify(request), userInput: extractUserInput(request),
    webSearch: request.web_search, reasoningEffort: request.reasoning_effort,
    responseStatus: result.success ? 200 : result.status || 500,
    responseBody: !result.success ? JSON.stringify(errorBody) : !request.stream ? JSON.stringify(result.body) : undefined,
    latency, isStream: Boolean(request.stream), errorMessage: result.error,
  }) : undefined

  ctx.state.requestLogged = Boolean(log)
  if (!result.success) {
    ctx.status = result.status || 500
    ctx.body = errorBody
    return
  }
  if (request.stream && result.stream) {
    ctx.set('Content-Type', 'text/event-stream')
    ctx.set('Cache-Control', 'no-cache')
    ctx.set('X-Accel-Buffering', 'no')
    const transforms = result.skipTransform ? [] : [streamHandler.createTransformStream(actualModel, requestId)]
    const output = relayResponseStream(result.stream, transforms, 'openai', (error, body) => {
      dispatched.finishStream?.(error)
      storeManager.recordTokenUsage(request.model, extractTokenCount(body))
      if (log) storeManager.updateRequestLog(log.id, {
        status: error ? 'error' : 'success', responseBody: body || undefined,
        errorMessage: error?.message, latency: Date.now() - startTime,
      })
    })
    ctx.body = output
    // The client may have left while its model was still loading.
    if (signal.aborted) output.destroy()
    return
  }
  ctx.body = isAnthropicToolFormat(request.tool_format) ? transformResponseToAnthropic(result.body) : result.body
})

export default router
