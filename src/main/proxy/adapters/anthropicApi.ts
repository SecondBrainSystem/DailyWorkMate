import axios from 'axios'
import { convertUpstreamStream } from '../responseStream.ts'
import type { Account, Provider } from '../../store/types.ts'
import type { ChatCompletionRequest, ForwardResult } from '../types.ts'
import { ModelFeatureError } from '../modelFeatures.ts'
import { claudeToOpenAIResponse, createClaudeToOpenAIStream, openAIToClaudeRequest } from '../ollamaProtocol.ts'
import { readUpstreamErrorBody } from '../upstreamError.ts'
import { ANTHROPIC_VERSION } from '../../providers/apiProviders.ts'

/** OpenAI clients often omit max_tokens; the Messages API requires it, so use a size that does not cut answers short. */
const DEFAULT_MAX_TOKENS = 8192

/** Anthropic Messages body for an OpenAI chat request. */
export function anthropicApiBody(request: ChatCompletionRequest, model: string): Record<string, unknown> {
  const body = openAIToClaudeRequest({ ...request, max_tokens: request.max_completion_tokens ?? request.max_tokens ?? DEFAULT_MAX_TOKENS }, model)
  // Current Claude models accept temperature or top_p, not both; OpenAI clients often send top_p: 1.
  const { top_p: topP, ...rest } = body
  return body.temperature !== undefined && topP !== undefined ? rest : body
}

export function anthropicMessagesUrl(apiEndpoint: string): string {
  const base = apiEndpoint.replace(/\/+$/, '')
  return base.endsWith('/v1') ? base + '/messages' : base + '/v1/messages'
}

/** Official Claude API: OpenAI-format requests in, Messages API on the wire, OpenAI-format responses out. */
export async function forwardAnthropicApi(request: ChatCompletionRequest, account: Account, provider: Provider, model: string, timeout: number, signal?: AbortSignal): Promise<ForwardResult> {
  const started = Date.now()
  try {
    const apiKey = account.credentials.apiKey
    if (!apiKey) return { success: false, status: 401, error: 'This Claude API account has no API key' }
    const response = await axios.post(anthropicMessagesUrl(provider.apiEndpoint), anthropicApiBody(request, model), {
      headers: { 'content-type': 'application/json', accept: request.stream ? 'text/event-stream' : 'application/json', 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      timeout, signal, responseType: request.stream ? 'stream' : 'json', validateStatus: () => true, maxBodyLength: Infinity, maxContentLength: Infinity,
    })
    const latency = Date.now() - started
    if (response.status >= 400) {
      const data = await readUpstreamErrorBody(response.data) as { error?: { message?: string }; message?: string } | string | undefined
      const message = (typeof data === 'string' ? data : data?.error?.message || data?.message) || 'HTTP ' + response.status
      return { success: false, status: response.status, error: 'Claude API: ' + String(message).slice(0, 2000), latency }
    }
    if (request.stream) return { success: true, status: response.status, stream: convertUpstreamStream(response.data, createClaudeToOpenAIStream(model)), skipTransform: true, latency }
    if (!Array.isArray(response.data?.content)) return { success: false, status: 502, error: 'Claude API returned an invalid message', latency }
    return { success: true, status: response.status, body: claudeToOpenAIResponse(response.data, model), latency }
  } catch (error) {
    const latency = Date.now() - started
    if (error instanceof ModelFeatureError) return { success: false, status: 400, error: error.message, latency }
    const status = signal?.aborted || axios.isCancel(error) ? 499
      : axios.isAxiosError(error) && ['ECONNABORTED', 'ETIMEDOUT'].includes(error.code || '') ? 504 : 502
    return { success: false, status, error: 'Claude API request failed: ' + (error instanceof Error ? error.message : String(error)), latency }
  }
}
