import Router from '@koa/router'
import type { Context } from 'koa'
import { ModelFeatureError } from '../modelFeatures'
import { dispatchChatCompletion } from '../dispatch'
import { storeManager } from '../../store/store'
import { extractTokenCount } from '../tokenUsage'
import { clientAbortSignal, relayResponseStream } from '../responseStream'
import {
  claudeRequestToOpenAI,
  createOpenAISseToClaudeStream,
  openAIResponseToClaude,
} from '../ollamaProtocol'

const router = new Router({ prefix: '/v1' })

router.post('/messages', async (ctx: Context) => {
  const request = ctx.request.body as any
  if (!request?.model || !Array.isArray(request?.messages)) {
    ctx.status = 400
    ctx.body = { type: 'error', error: { type: 'invalid_request_error', message: 'model and messages are required' } }
    return
  }

  let openAIRequest
  try { openAIRequest = claudeRequestToOpenAI(request) } catch (error) {
    if (!(error instanceof ModelFeatureError)) throw error
    ctx.status = 400
    ctx.body = { type: 'error', error: { type: 'invalid_request_error', message: error.message } }
    return
  }
  const signal = clientAbortSignal(ctx)
  const dispatched = await dispatchChatCompletion(
    openAIRequest,
    `msg-${Date.now().toString(36)}`,
    ctx.ip,
    ctx.headers,
    signal,
  )
  ctx.state.dispatchSelection = dispatched.selection
  if (!dispatched.result.success) {
    ctx.status = dispatched.result.status || 500
    ctx.body = { type: 'error', error: { type: 'api_error', message: dispatched.result.error || 'Request failed' } }
    return
  }

  const model = dispatched.selection?.actualModel || request.model
  if (request.stream && dispatched.result.stream) {
    ctx.set('Content-Type', 'text/event-stream')
    ctx.set('Cache-Control', 'no-cache')
    ctx.set('X-Accel-Buffering', 'no')
    const output = relayResponseStream(dispatched.result.stream, [createOpenAISseToClaudeStream(model)], 'claude', (error, body) => {
      ctx.state.streamError = error?.message
      ctx.state.responseLogBody = body
      dispatched.finishStream?.(error)
      storeManager.recordTokenUsage(request.model, extractTokenCount(body))
    })
    ctx.body = output
    if (signal.aborted) output.destroy()
    return
  }
  ctx.body = openAIResponseToClaude(dispatched.result.body, model)
})

export default router
