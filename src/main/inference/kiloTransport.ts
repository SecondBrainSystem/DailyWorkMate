import { explicitThinking } from '../../shared/modelFeatures.ts'
import type { KiloFreeModel } from '../../shared/freeModels.ts'
import type { ChatCompletionRequest, ForwardResult } from '../proxy/types'
import { KILO_BASE_URL, KiloModelError, kiloFreeModels } from './kiloModels.ts'
import { forwardFreeChat } from './freeTransport'

export function buildKiloRequest(request: ChatCompletionRequest, model: KiloFreeModel): Record<string, unknown> {
  if (request.web_search || request.web_search_options || request.deep_research) throw new KiloModelError('Kilo 免费通道不支持联网搜索或深度研究参数。 / Kilo free models do not support search or deep research parameters.', 400)
  if (request.tools?.length && !model.toolCall) throw new KiloModelError('该 Kilo 模型不支持工具调用，请选择其他模型。 / Select a Kilo model with tool support.', 400)
  if (!model.vision && request.messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'))) throw new KiloModelError('该 Kilo 模型不支持图片。 / This Kilo model does not support images.', 400)
  const thinking = explicitThinking(request)
  if (thinking === true && !model.reasoning) throw new KiloModelError('该 Kilo 模型不支持思考设置。 / This Kilo model does not support reasoning.', 400)
  const effort = request.reasoning_effort
  // Pass declared OpenRouter reasoning controls; upstream remains authoritative about mandatory reasoning.
  const reasoning = thinking === false ? { enabled: false }
    : effort && effort !== 'none' ? { effort }
      : thinking === true ? { enabled: true } : undefined
  const fields = ['temperature', 'top_p', 'stop', 'seed', 'response_format', 'presence_penalty', 'frequency_penalty', 'tools', 'tool_choice', 'parallel_tool_calls'] as const
  const parameters = Object.fromEntries(fields.flatMap(key => request[key] !== undefined && model.parameters.includes(key) ? [[key, request[key]]] : []))
  const maxTokens = request.max_completion_tokens ?? request.max_tokens
  if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens < 1)) throw new KiloModelError('max_tokens must be a positive integer', 400)
  return { ...parameters, model: model.apiModel,
    messages: request.messages.map(message => ({ ...message,
      // Kilo/OpenRouter names this field reasoning, while desktop clients use reasoning_content.
      ...(message.reasoning_content === undefined ? {} : { reasoning: message.reasoning_content }),
    })), stream: true, stream_options: { include_usage: true },
    ...(maxTokens === undefined ? {} : { max_tokens: Math.min(maxTokens, model.outputLimit) }),
    ...(reasoning && model.reasoning ? { reasoning } : {}),
  }
}

export function forwardKiloCompletion(request: ChatCompletionRequest, signal?: AbortSignal, timeout = 120_000,
  dependencies: { fetch?: typeof fetch; resolve?: (id: string) => Promise<KiloFreeModel> } = {}): Promise<ForwardResult> {
  return forwardFreeChat(request, {
    label: 'Kilo', code: 'kilo', fetch: dependencies.fetch,
    prepare: async () => ({
      url: KILO_BASE_URL + '/chat/completions',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: buildKiloRequest(request, await (dependencies.resolve ?? (id => kiloFreeModels.resolve(id)))(request.model)),
    }),
  }, signal, timeout)
}
