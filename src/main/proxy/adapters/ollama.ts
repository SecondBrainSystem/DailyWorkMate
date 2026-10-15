import axios, { type AxiosRequestConfig } from 'axios'
import { convertUpstreamStream } from '../responseStream'
import type { Account, Provider } from '../../store/types'
import type { ChatCompletionRequest, ForwardResult } from '../types'
import { ModelFeatureError, normalizeFeatureRequest, openAIThinkingFields, validateProviderFeatures } from '../modelFeatures'
import { buildOllamaHeaders, isOllamaResponse } from '../../ollama/transport'
import { normalizeOllamaUrl } from '../../ollama/urls'
import { readUpstreamErrorBody } from '../upstreamError'
import { createOllamaAgents } from '../connectionAgents'
import { requestOllama } from '../../ollama/request'
import { awaitFirstOutput } from '../firstOutput'
import {
  claudeToOpenAIResponse,
  createClaudeToOpenAIStream,
  createOllamaNdjsonToOpenAIStream,
  createOpenAICompletionToChatStream,
  createValidatedOpenAIStream,
  openAIToClaudeRequest,
  openAIToOllamaChat,
  openAIToOllamaGenerate,
  ollamaChatToOpenAI,
  ollamaGenerateToOpenAI,
  validateTextCompletionTools,
} from '../ollamaProtocol'

/** Attempts per streaming request when the node closes the response before any output. */
const STREAM_ATTEMPTS = 2

function promptFromRequest(request: ChatCompletionRequest): string {
  return request.messages.map(message => {
    const content = typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? message.content.filter(part => part.type === 'text').map(part => part.text || '').join('\n')
        : ''
    return `${message.role.toUpperCase()}: ${content}`
  }).join('\n\n')
}

function upstreamError(data: any, status: number, path: string): string {
  const detail = data?.error?.message || data?.error || data?.message
  const text = typeof detail === 'string' ? detail : detail ? JSON.stringify(detail) : ''
  return `Ollama ${path} returned HTTP ${status}${text ? `: ${text}` : ''}`
}

export class OllamaAdapter {
  static isOllamaProvider(provider: Provider): boolean {
    return provider.upstreamKind === 'ollama'
  }

  static async forward(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    timeout: number,
    signal?: AbortSignal,
  ): Promise<ForwardResult> {
    const metadata = provider.ollamaModels?.[actualModel]
    const endpoint = metadata?.endpoint
    if (!endpoint) return { success: false, status: 503, error: `No Ollama endpoint for model: ${actualModel}. Refresh the node's model list.` }

    let path = '/api/chat'
    try {
      request = normalizeFeatureRequest(request)
      validateProviderFeatures(request, provider, actualModel)
      const headers = buildOllamaHeaders(account, provider.headers)
      if (endpoint === 'claude_chat') headers['anthropic-version'] ||= '2023-06-01'
      headers.accept = request.stream
        ? endpoint.startsWith('ollama_') ? 'application/x-ndjson' : 'text/event-stream'
        : 'application/json'
      const common: AxiosRequestConfig = {
        method: 'POST', headers, timeout, signal, maxRedirects: 0,
        ...createOllamaAgents(timeout),
        validateStatus: () => true,
        responseType: request.stream ? 'stream' : 'json',
      }

      let data: Record<string, unknown>
      if (endpoint === 'openai_chat') {
        path = '/v1/chat/completions'
        const { _signal, _timeout, enable_thinking, enable_vision, vision, think, thinking, reasoning_effort, reasoningEffort, extra_body, originalModel, ...compatible } = request
        // Native fields have already been mapped to standard request fields.
        const { options, format, keep_alive, ...body } = compatible as typeof compatible & Record<string, unknown>
        data = { ...body, model: actualModel, ...openAIThinkingFields(request, actualModel, provider.apiEndpoint, true) }
      } else if (endpoint === 'ollama_generate') {
        path = '/api/generate'
        data = openAIToOllamaGenerate(request, actualModel)
      } else if (endpoint === 'openai_completion') {
        path = '/v1/completions'
        validateTextCompletionTools(request)
        data = {
          model: actualModel, prompt: promptFromRequest(request), stream: Boolean(request.stream),
          max_tokens: request.max_completion_tokens ?? request.max_tokens,
          temperature: request.temperature, top_p: request.top_p, stop: request.stop,
          seed: request.seed, frequency_penalty: request.frequency_penalty, presence_penalty: request.presence_penalty,
        }
      } else if (endpoint === 'claude_chat') {
        path = '/v1/messages'
        data = openAIToClaudeRequest(request, actualModel)
      } else {
        data = openAIToOllamaChat(request, actualModel)
      }

      const url = `${normalizeOllamaUrl(provider.apiEndpoint)}${path}`
      const failedStatus = async (response: { status: number; data: unknown }): Promise<ForwardResult> => ({
        success: false,
        status: response.status >= 400 ? response.status : 502,
        error: upstreamError(await readUpstreamErrorBody(response.data), response.status, path),
      })

      if (request.stream) {
        const convert = (source: any) => convertUpstreamStream(source,
          endpoint === 'openai_chat' ? createValidatedOpenAIStream()
            : endpoint === 'ollama_chat' || endpoint === 'ollama_generate' ? createOllamaNdjsonToOpenAIStream(actualModel)
              : endpoint === 'openai_completion' ? createOpenAICompletionToChatStream(actualModel)
                : createClaudeToOpenAIStream(actualModel))
        // Some nodes intermittently answer HTTP 200 and close the response before any output.
        // Nothing has reached the client yet at that point, so ask once more on a fresh
        // connection; if the node keeps doing it, fail the request so another node can be tried.
        for (let attempt = 1; ; attempt += 1) {
          const response = await requestOllama({ ...common, url, data }, timeout)
          if (response.status < 200 || response.status >= 300) return failedStatus(response)
          const first = await awaitFirstOutput(convert(response.data), timeout, signal)
          if (first.ok) return { success: true, status: response.status, stream: first.stream, skipTransform: true }
          if (first.reason === 'aborted' || signal?.aborted) return { success: false, status: 499, error: `Ollama ${path} request cancelled` }
          if (first.reason === 'timeout') return { success: false, status: 504, error: `Ollama ${path} stream: ${first.error.message}` }
          if (first.reason === 'stream_error' && attempt < STREAM_ATTEMPTS) continue
          return {
            success: false,
            status: 502,
            error: `Ollama ${path} stream produced no output: ${first.error.message}${attempt > 1 ? ` (tried ${attempt} times)` : ''}`,
          }
        }
      }

      const response = await requestOllama({ ...common, url, data }, timeout)
      if (response.status < 200 || response.status >= 300) return failedStatus(response)
      if (!isOllamaResponse(response.data, endpoint)) {
        return { success: false, status: 502, error: response.data?.error
          ? upstreamError(response.data, response.status, path)
          : `Ollama ${path} returned an invalid ${endpoint} response` }
      }
      if (endpoint === 'openai_chat') return { success: true, status: response.status, body: response.data }
      if (endpoint === 'ollama_chat') return { success: true, status: response.status, body: ollamaChatToOpenAI(response.data, actualModel) }
      if (endpoint === 'ollama_generate') return { success: true, status: response.status, body: ollamaGenerateToOpenAI(response.data, actualModel) }
      if (endpoint === 'openai_completion') {
        const completion = response.data
        return {
          success: true,
          status: response.status,
          body: {
            id: completion.id,
            object: 'chat.completion',
            created: completion.created,
            model: completion.model || actualModel,
            choices: [{
              index: 0,
              message: { role: 'assistant', content: completion.choices?.[0]?.text || '' },
              finish_reason: completion.choices?.[0]?.finish_reason || 'stop',
            }],
            usage: completion.usage,
          },
        }
      }
      return { success: true, status: response.status, body: claudeToOpenAIResponse(response.data, actualModel) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const status = signal?.aborted || axios.isCancel(error) ? 499
        : error instanceof ModelFeatureError ? 400
          : axios.isAxiosError(error) && ['ECONNABORTED', 'ETIMEDOUT'].includes(error.code || '') ? 504 : 502
      return { success: false, status, error: `Ollama ${path} request failed: ${message}` }
    }
  }
}
