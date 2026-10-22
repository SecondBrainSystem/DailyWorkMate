/**
 * The catalog uses the same eligibility checks as dispatch without selecting an account.
 */
import Router from '@koa/router'
import type { Context } from 'koa'
import { availableModelInfo } from '../modelCatalog'
import { verifyModelSelection } from '../modelVerification'
import { clientAbortSignal } from '../responseStream'
import { listInferenceModels, resolveProxyFreeModel } from '../../inference/modelListing'
import { KiloModelError } from '../../inference/kiloModels'
import { OpenCodeModelError } from '../../companion/opencodeModels'
import { freeModelSource } from '../../../shared/freeModels'

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
  ctx.set('Content-Type', 'application/json')
  ctx.body = await listInferenceModels(ctx.get('X-Refresh-Free-Models') === 'true', clientAbortSignal(ctx), true)
})

router.get('/models/:model', async (ctx: Context) => {
  const modelId = ctx.params.model
  const source = freeModelSource(modelId)
  if (source) {
    try {
      const model = await resolveProxyFreeModel(modelId, clientAbortSignal(ctx))
      ctx.body = { id: model.id, name: model.name, object: 'model', created: 0, owned_by: source.name }
    } catch (error) {
      if (!(error instanceof KiloModelError) && !(error instanceof OpenCodeModelError)) throw error
      ctx.status = error.status
      ctx.body = { error: { message: error.message, type: error.status < 500 ? 'invalid_request_error' : 'api_error',
        param: 'model', code: error.status === 404 ? 'model_not_found' : 'free_model_unavailable' } }
    }
    return
  }
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
