import Router from '@koa/router'
import type { Context } from 'koa'
import { ModelFeatureError } from '../modelFeatures'
import { dispatchChatCompletion } from '../dispatch'
import { loadBalancer } from '../loadbalancer'
import { storeManager } from '../../store/store'
import { extractTokenCount } from '../tokenUsage'
import { clientAbortSignal, relayResponseStream } from '../responseStream'
import {
  createOpenAISseToOllamaStream,
  ollamaRequestToOpenAI,
  openAIResponseToOllama,
} from '../ollamaProtocol'

const router = new Router({ prefix: '/api' })

router.get('/version', ctx => { ctx.body = { version: '0.0.0', dailyworkmate: true } })
router.post('/show', ctx => {
  const body = ctx.request.body as { model?: string; name?: string }
  const model = body?.model || body?.name
  const metadata = storeManager.getProviders().flatMap(provider => Object.values(provider.ollamaModels || {})).find(entry => entry.name === model)
  if (!model || !loadBalancer.getAvailableModels().includes(model)) { ctx.status = 404; ctx.body = { error: 'Model not found' }; return }
  ctx.body = { capabilities: ['completion', ...(metadata?.vision === 'supported' ? ['vision'] : [])], details: {}, model_info: {}, parameters: '' }
})

router.get('/tags', async (ctx: Context) => {
  ctx.body = {
    models: loadBalancer.getAvailableModels().map(name => ({
      name,
      model: name,
      modified_at: new Date().toISOString(),
    })),
  }
})

router.post('/chat', async (ctx: Context) => {
  const request = ctx.request.body as any
  if (!request?.model || !Array.isArray(request?.messages)) {
    ctx.status = 400
    ctx.body = { error: 'model and messages are required' }
    return
  }

  let openAIRequest
  try { openAIRequest = ollamaRequestToOpenAI(request) } catch (error) {
    if (!(error instanceof ModelFeatureError)) throw error
    ctx.status = 400
    ctx.body = { error: error.message }
    return
  }
  const signal = clientAbortSignal(ctx)
  const dispatched = await dispatchChatCompletion(
    openAIRequest,
    `ollama-${Date.now().toString(36)}`,
    ctx.ip,
    ctx.headers,
    signal,
  )
  ctx.state.dispatchSelection = dispatched.selection
  if (!dispatched.result.success) {
    ctx.status = dispatched.result.status || 500
    ctx.body = { error: dispatched.result.error || 'Request failed' }
    return
  }

  const model = dispatched.selection?.actualModel || request.model
  if (openAIRequest.stream && dispatched.result.stream) {
    ctx.set('Content-Type', 'application/x-ndjson')
    ctx.set('Cache-Control', 'no-cache')
    ctx.set('X-Accel-Buffering', 'no')
    const output = relayResponseStream(dispatched.result.stream, [createOpenAISseToOllamaStream(model)], 'ollama', (error, body) => {
      ctx.state.streamError = error?.message
      ctx.state.responseLogBody = body
      dispatched.finishStream?.(error)
      storeManager.recordTokenUsage(request.model, extractTokenCount(body))
    })
    ctx.body = output
    if (signal.aborted) output.destroy()
    return
  }
  ctx.body = openAIResponseToOllama(dispatched.result.body, model)
})

export default router
