/**
 * Proxy Service Module - Completions Route (Optional)
 * Implements /v1/completions route (legacy API)
 */

import Router from '@koa/router'
import type { Context } from 'koa'
import { Transform } from 'stream'
import { dispatchChatCompletion } from '../dispatch'
import { streamHandler } from '../stream'
import { storeManager } from '../../store/store'
import { extractTokenCount } from '../tokenUsage'
import { jsonSseTransform } from '../jsonSseTransform'
import { clientAbortSignal, relayResponseStream } from '../responseStream'

const router = new Router({ prefix: '/v1' })

interface CompletionRequest {
  model: string
  prompt: string | string[]
  max_tokens?: number
  temperature?: number
  top_p?: number
  n?: number
  stream?: boolean
  stop?: string | string[]
  echo?: boolean
}

/**
 * Generate request ID
 */
function generateRequestId(): string {
  return `cmpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Convert prompt to messages format
 */
function promptToMessages(prompt: string | string[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  if (Array.isArray(prompt)) {
    return prompt.map((p, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: p,
    }))
  }

  return [{ role: 'user', content: prompt }]
}

function chatBodyToCompletion(body: any, model: string): Record<string, unknown> {
  const choice = body?.choices?.[0] || {}
  return {
    id: body?.id || `cmpl-${Date.now().toString(36)}`,
    object: 'text_completion',
    created: body?.created || Math.floor(Date.now() / 1000),
    model: body?.model || model,
    choices: [{
      index: 0,
      text: choice?.message?.content || choice?.text || '',
      finish_reason: choice?.finish_reason || 'stop',
    }],
    usage: body?.usage,
  }
}

export function createChatToCompletionStream(model: string): Transform {
  let finished = false
  let hasFinish = false
  const finish = (target: Transform) => {
    if (finished) return
    if (!hasFinish) throw new Error('Completion stream ended before its finish event')
    target.push('data: [DONE]\n\n')
    finished = true
    target.push(null)
  }
  return jsonSseTransform((target, data) => {
    if (finished) return
    if (data === '[DONE]') { hasFinish = true; finish(target); return }
    if (data.error) { target.push(`data: ${JSON.stringify(data)}\n\n`); hasFinish = true; finish(target); return }
    if (!Array.isArray(data.choices)) throw new Error('Invalid completion stream event')
    if (data.choices.some((choice: any) => choice.finish_reason)) hasFinish = true
    target.push(`data: ${JSON.stringify({
      ...data, object: 'text_completion', model: data.model || model,
      choices: data.choices.map((choice: any) => ({ index: choice.index ?? 0,
        text: choice.delta?.content ?? choice.text ?? '', finish_reason: choice.finish_reason ?? null,
      })),
    })}\n\n`)
  }, finish)
}

/**
 * Handle Completions request
 */
router.post('/completions', async (ctx: Context) => {
  const requestId = generateRequestId()

  let request: CompletionRequest
  try {
    request = ctx.request.body as CompletionRequest
  } catch (error) {
    ctx.status = 400
    ctx.body = {
      error: {
        message: 'Invalid request body',
        type: 'invalid_request_error',
      },
    }
    return
  }

  if (!request || typeof request.model !== 'string' || !request.model.trim()) {
    ctx.status = 400
    ctx.body = {
      error: {
        message: 'Missing required field: model',
        type: 'invalid_request_error',
        param: 'model',
      },
    }
    return
  }

  if (request.prompt === undefined) {
    ctx.status = 400
    ctx.body = {
      error: {
        message: 'Missing required field: prompt',
        type: 'invalid_request_error',
        param: 'prompt',
      },
    }
    return
  }

  if (typeof request.prompt !== 'string' && !(Array.isArray(request.prompt)
    && request.prompt.length === 1 && typeof request.prompt[0] === 'string')) {
    ctx.status = 400
    ctx.body = { error: { message: 'Use one text prompt per request; batched or token-array prompts are not supported.', type: 'invalid_request_error', param: 'prompt' } }
    return
  }

  const chatRequest = {
    ...request,
    model: request.model,
    messages: promptToMessages(request.prompt),
    max_tokens: request.max_tokens,
    temperature: request.temperature,
    top_p: request.top_p,
    n: request.n,
    stream: request.stream,
    stop: request.stop,
  }

  const signal = clientAbortSignal(ctx)
  const dispatched = await dispatchChatCompletion(chatRequest, requestId, ctx.ip, ctx.headers, signal)
  ctx.state.dispatchSelection = dispatched.selection
  if (!dispatched.result.success) {
    ctx.status = dispatched.result.status || 500
    ctx.body = {
      error: {
        message: dispatched.result.error || 'Request failed',
        type: 'api_error',
      },
    }
    return
  }

  const actualModel = dispatched.selection?.actualModel || request.model
  if (request.stream && dispatched.result.stream) {
    ctx.set('Content-Type', 'text/event-stream')
    ctx.set('Cache-Control', 'no-cache')
    ctx.set('Connection', 'keep-alive')
    ctx.set('X-Accel-Buffering', 'no')

    const transforms = dispatched.result.skipTransform ? [] : [streamHandler.createTransformStream(actualModel, requestId)]
    const output = relayResponseStream(dispatched.result.stream, [...transforms, createChatToCompletionStream(actualModel)], 'openai', (error, body) => {
      ctx.state.streamError = error?.message
      ctx.state.responseLogBody = body
      dispatched.finishStream?.(error)
      storeManager.recordTokenUsage(request.model, extractTokenCount(body))
    })
    ctx.body = output
    if (signal.aborted) output.destroy()
  } else {
    ctx.set('Content-Type', 'application/json')
    ctx.body = chatBodyToCompletion(dispatched.result.body, actualModel)
  }
})

export default router
