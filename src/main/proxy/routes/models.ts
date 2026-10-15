/**
 * The catalog uses the same eligibility checks as dispatch without selecting an account.
 */
import Router from '@koa/router'
import type { Context } from 'koa'
import type { ModelsResponse } from '../types'
import { availableModelInfo, listAvailableModels } from '../modelCatalog'
import { verifyModelSelection } from '../modelVerification'
import { clientAbortSignal } from '../responseStream'

const router = new Router({ prefix: '/v1' })

router.post('/models/verify', async (ctx: Context) => {
  const body = ctx.request.body as { model?: unknown; recover?: unknown } | undefined
  if (!body || typeof body.model !== 'string' || !body.model.trim() || body.model.length > 512
    || (body.recover !== undefined && typeof body.recover !== 'boolean')) {
    ctx.status = 400
    ctx.body = { error: { message: 'A model and optional boolean recover are required', code: 'invalid_request' } }
    return
  }
  const result = await verifyModelSelection(body.model.trim(), body.recover === true, clientAbortSignal(ctx))
  if (result.success) ctx.body = result.value
  else {
    ctx.status = result.result.status || 503
    ctx.body = { error: { message: result.result.error, code: result.result.errorCode || 'model_verification_failed' } }
  }
})

router.get('/models', async (ctx: Context) => {
  const response: ModelsResponse = {
    object: 'list',
    data: listAvailableModels(),
  }
  ctx.set('Content-Type', 'application/json')
  ctx.body = response
})

router.get('/models/:model', async (ctx: Context) => {
  const modelId = ctx.params.model
  const model = availableModelInfo(modelId)
  if (model) {
    ctx.set('Content-Type', 'application/json')
    ctx.body = model
    return
  }
  ctx.status = 404
  ctx.body = {
    error: {
      message: `Model '${modelId}' not found`,
      type: 'invalid_request_error',
      param: 'model',
      code: 'model_not_found',
    },
  }
})

export default router
