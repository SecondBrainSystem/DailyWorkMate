import Router from '@koa/router'
import type { Context } from 'koa'
import ConfigManager from '../../../store/config'
import { managementAuthMiddleware } from '../../middleware/managementAuth'
import {
  buildSmokeFixture,
  getLatestToolCallingSmokeResult,
  setLatestToolCallingSmokeResult,
} from '../../toolCalling/diagnostics'
import type { ManagementApiResponse } from '../../../../shared/types'
import type { ToolClientAdapterId } from '../../../../shared/toolCalling'
import { dispatchChatCompletion } from '../../dispatch'
import { storeManager } from '../../../store/store'
import { loadBalancer } from '../../loadbalancer'
import { randomUUID } from 'node:crypto'
import type { ChatCompletionRequest, ChatCompletionResponse } from '../../types'

const router = new Router({ prefix: '/v0/management/tool-calling' })

router.use(managementAuthMiddleware)

router.get('/status', async (ctx: Context) => {
  const config = ConfigManager.get()

  ctx.body = {
    success: true,
    data: {
      config: config.toolCallingConfig,
      latestSmokeResult: getLatestToolCallingSmokeResult(),
    },
  } as ManagementApiResponse
})

router.post('/smoke', async (ctx: Context) => {
  const body = ctx.request.body as { clientAdapterId?: ToolClientAdapterId; model?: string }
  const config = ConfigManager.get()
  const clientAdapterId = body.clientAdapterId ?? config.toolCallingConfig.clientAdapterId
  const fixture = buildSmokeFixture(clientAdapterId)

  const model = body.model || storeManager.getProviders().filter(provider => provider.enabled)
    .flatMap(provider => storeManager.getEffectiveModels(provider.id).map(entry => entry.displayName))
    .find(candidate => !candidate.includes('*') && loadBalancer.getAvailableAccountCount(candidate) > 0)
  if (!model) { ctx.status = 400; ctx.body = { success: false, error: { message: 'No usable model is configured' } }; return }
  const requestId = randomUUID()
  const response = await dispatchChatCompletion({ ...fixture, model } as ChatCompletionRequest, requestId)
  const calls = (response.result.body as ChatCompletionResponse | undefined)?.choices?.[0]?.message?.tool_calls
  const success = response.result.success && !!calls?.some(call => call.function.name === 'weather-test:get_weather')
  const result = setLatestToolCallingSmokeResult({
    success,
    category: success ? 'pass' : response.result.success ? 'model_did_not_call_tool' : 'provider_or_account_error',
    message: success ? 'The selected provider returned the requested tool call.' : response.result.error || 'The model did not return the requested tool call.',
    clientAdapterId,
    requestId,
    providerId: response.selection?.provider.id,
    timestamp: Date.now(),
  })

  ctx.body = {
    success,
    data: {
      result,
      fixture,
    },
  } as ManagementApiResponse
})

export default router
