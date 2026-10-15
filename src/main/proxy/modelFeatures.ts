import {
  explicitThinking,
  normalizeModelFeatureDefaults,
  type ModelFeatureDefaults,
  type ModelFeatureInput,
} from '../../shared/modelFeatures.ts'
import type { ChatCompletionRequest, ChatMessage } from './types'
import type { Provider } from '../store/types'

export class ModelFeatureError extends Error {
  readonly status = 400
  readonly param: string

  constructor(message: string, param = 'enable_thinking') {
    super(message)
    this.name = 'ModelFeatureError'
    this.param = param
  }
}

const efforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const levels = new Set(['low', 'medium', 'high', 'max'])

export function validateFeatureInput(input: ModelFeatureInput): void {
  if (input.chat_template_kwargs !== undefined) {
    const template = input.chat_template_kwargs
    if (!template || typeof template !== 'object' || Array.isArray(template)) {
      throw new ModelFeatureError('chat_template_kwargs must be an object', 'chat_template_kwargs')
    }
    for (const key of ['thinking', 'enable_thinking'] as const) {
      if (template[key] !== undefined && typeof template[key] !== 'boolean') {
        throw new ModelFeatureError(`chat_template_kwargs.${key} must be a boolean`, 'chat_template_kwargs')
      }
    }
  }
  for (const key of ['enable_thinking', 'enable_vision', 'vision'] as const) {
    if (input[key] !== undefined && typeof input[key] !== 'boolean') {
      throw new ModelFeatureError(`${key} must be a boolean`, key)
    }
  }
  if (input.think !== undefined && typeof input.think !== 'boolean' && !levels.has(input.think)) {
    throw new ModelFeatureError('think must be a boolean or low/medium/high/max', 'think')
  }
  for (const key of ['reasoning_effort', 'reasoningEffort'] as const) {
    const value = input[key]
    if (value !== undefined && value !== false && !efforts.has(value)) {
      throw new ModelFeatureError(`${key} must be none/minimal/low/medium/high/xhigh/max`, key)
    }
  }
  const thinking = input.thinking
  if (thinking !== undefined && typeof thinking !== 'boolean') {
    if (!thinking || typeof thinking !== 'object' || !['enabled', 'disabled', 'adaptive'].includes(thinking.type)) {
      throw new ModelFeatureError('thinking.type must be enabled, disabled or adaptive', 'thinking')
    }
    if (thinking.budget_tokens !== undefined && (!Number.isInteger(thinking.budget_tokens) || thinking.budget_tokens < 1)) {
      throw new ModelFeatureError('thinking.budget_tokens must be a positive integer', 'thinking')
    }
  }
}

export function validateChatRequest(input: unknown): asserts input is ChatCompletionRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ModelFeatureError('Request body must be an object', 'body')
  }
  const request = input as ChatCompletionRequest
  if (typeof request.model !== 'string' || !request.model.trim()) {
    throw new ModelFeatureError('model must be a non-empty string', 'model')
  }
  if (!Array.isArray(request.messages) || !request.messages.length) {
    throw new ModelFeatureError('messages must be a non-empty array', 'messages')
  }
  for (const message of request.messages) {
    if (!message || !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)) {
      throw new ModelFeatureError('Invalid message role', 'messages')
    }
    const toolOnly = message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0
    if (message.content !== null && typeof message.content !== 'string' && !Array.isArray(message.content)
      && !(message.content === undefined && toolOnly)) {
      throw new ModelFeatureError('Message content must be text, content parts or null', 'messages')
    }
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (!part || typeof part !== 'object' || !['text', 'image_url'].includes(part.type)
          || (part.type === 'text' && typeof part.text !== 'string')
          || (part.type === 'image_url' && (typeof part.image_url?.url !== 'string' || !part.image_url.url.trim()))) {
          throw new ModelFeatureError('Invalid message content part', 'messages')
        }
      }
    }
    if (message.reasoning_content !== undefined && typeof message.reasoning_content !== 'string') {
      throw new ModelFeatureError('reasoning_content must be text', 'messages')
    }
    if (message.tool_calls !== undefined) {
      if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) {
        throw new ModelFeatureError('tool_calls must be an array on an assistant message', 'messages')
      }
      for (const call of message.tool_calls) {
        if (!call || call.type !== 'function' || typeof call.id !== 'string' || !call.id
          || typeof call.function?.name !== 'string' || !call.function.name.trim()
          || typeof call.function.arguments !== 'string') {
          throw new ModelFeatureError('Invalid tool call: id, function name and JSON arguments are required', 'messages')
        }
        try {
          const args = JSON.parse(call.function.arguments)
          if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Expected object')
        } catch {
          throw new ModelFeatureError('Tool call arguments must encode a JSON object', 'messages')
        }
      }
    }
    if (message.role === 'tool' && (typeof message.tool_call_id !== 'string' || !message.tool_call_id)) {
      throw new ModelFeatureError('Tool results require tool_call_id', 'messages')
    }
  }
  if (request.tools !== undefined && (!Array.isArray(request.tools) || request.tools.some(tool =>
    !tool || tool.type !== 'function' || typeof tool.function?.name !== 'string' || !tool.function.name.trim()
    || (tool.function.parameters !== undefined && (!tool.function.parameters || typeof tool.function.parameters !== 'object' || Array.isArray(tool.function.parameters)))))) {
    throw new ModelFeatureError('tools must contain valid function definitions', 'tools')
  }
  if (request.tool_choice !== undefined && !['none', 'auto', 'required'].includes(request.tool_choice as string)
    && !(typeof request.tool_choice === 'object' && request.tool_choice?.type === 'function'
      && typeof request.tool_choice.function?.name === 'string' && request.tool_choice.function.name.trim())) {
    throw new ModelFeatureError('Invalid tool_choice', 'tool_choice')
  }
  if (request.stream !== undefined && typeof request.stream !== 'boolean') {
    throw new ModelFeatureError('stream must be a boolean', 'stream')
  }
}

function headerBoolean(headers: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  const key = keys.find(name => headers[name] !== undefined)
  if (!key) return undefined
  const value = headers[key]
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  throw new ModelFeatureError(`${key} must be true or false`, key)
}

/** Request body > headers > proxy defaults > upstream/model default. Does not mutate caller data. */
export function normalizeFeatureRequest(
  request: ChatCompletionRequest,
  defaults?: Partial<ModelFeatureDefaults>,
  headers: Record<string, unknown> = {},
): ChatCompletionRequest {
  validateChatRequest(request)
  if (request.extra_body !== undefined && (!request.extra_body || typeof request.extra_body !== 'object' || Array.isArray(request.extra_body))) {
    throw new ModelFeatureError('extra_body must be an object', 'extra_body')
  }
  const extra = (request.extra_body || {}) as ModelFeatureInput
  validateFeatureInput(request)
  validateFeatureInput(extra)
  const config = normalizeModelFeatureDefaults(defaults)
  const headerEffort = headers['x-reasoning-effort'] as ModelFeatureInput['reasoning_effort']
  if (headerEffort !== undefined) validateFeatureInput({ reasoning_effort: headerEffort })
  const enabledThinking = explicitThinking(request) ?? explicitThinking(extra)
    ?? headerBoolean(headers, 'x-enable-thinking')
    ?? (headerEffort === undefined ? undefined : headerEffort !== 'none')
    ?? (config.thinking === 'auto' ? undefined : config.thinking === 'enabled')
  const enabledVision = request.enable_vision ?? request.vision ?? extra.enable_vision ?? extra.vision
    ?? headerBoolean(headers, 'x-enable-vision')
    ?? (config.vision === 'auto' ? undefined : config.vision === 'enabled')
  const effort = request.reasoning_effort ?? request.reasoningEffort ?? extra.reasoning_effort ?? extra.reasoningEffort ?? headerEffort
  const merged: ChatCompletionRequest = {
    ...request,
    messages: request.messages.map(message => String(message.role) === 'developer' ? { ...message, role: 'system' as const } : message),
    ...(request.think === undefined && extra.think !== undefined ? { think: extra.think } : {}),
    ...(request.thinking === undefined && extra.thinking !== undefined ? { thinking: extra.thinking } : {}),
    ...(request.chat_template_kwargs === undefined && extra.chat_template_kwargs !== undefined ? { chat_template_kwargs: extra.chat_template_kwargs } : {}),
    ...(effort === undefined ? {} : { reasoning_effort: effort }),
    ...(enabledThinking === undefined ? {} : { enable_thinking: enabledThinking }),
    ...(enabledVision === undefined ? {} : { enable_vision: enabledVision }),
  }
  if (enabledVision !== false) return merged
  const messages = merged.messages.map((message): ChatMessage => {
    if (!Array.isArray(message.content)) return message
    const remaining = message.content.filter(part => part.type !== 'image_url')
    if (remaining.length === message.content.length) return message
    if (!remaining.some(part => part.type === 'text' && part.text?.trim())) {
      throw new ModelFeatureError('Vision is disabled and an image message has no text. Add text or enable vision.', 'enable_vision')
    }
    return { ...message, content: remaining }
  })
  return { ...merged, messages }
}

export function hasImageInput(request: ChatCompletionRequest): boolean {
  return request.messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'))
}

export function validateProviderFeatures(request: ChatCompletionRequest, provider: Provider, model: string): void {
  const thinking = explicitThinking(request)
  const name = model.toLowerCase()
  if (thinking === false && provider.type === 'builtin' && provider.id === 'glm' && request.deep_research) {
    throw new ModelFeatureError('GLM deep research requires thinking. Disable deep_research or enable thinking.')
  }
  if (thinking === false && (/gpt-oss|glm-5\.3(?:\b|-)|kimi-k2-thinking|qwen.*-thinking|^qwq|^minimax-m2/.test(name))) {
    throw new ModelFeatureError(`${model} cannot disable thinking. Use auto/enabled or select a model with a non-thinking mode.`)
  }
  if (provider.type === 'builtin' && provider.upstreamKind !== 'ollama') {
    if (provider.id === 'minimax' && thinking === false) {
      throw new ModelFeatureError('MiniMax web does not expose a supported thinking-off parameter. Use auto or choose another provider.')
    }
    if (provider.id === 'perplexity' && thinking !== undefined) {
      throw new ModelFeatureError('Perplexity web selects reasoning through its model; an independent thinking toggle is not supported. Use auto.')
    }
    if (hasImageInput(request) && provider.id !== 'glm') {
      throw new ModelFeatureError(`${provider.name} web adapter cannot forward image input. Disable vision for text-only requests or use a vision-capable API/Ollama model.`, 'enable_vision')
    }
  }
  const metadata = provider.ollamaModels?.[model]
  if (hasImageInput(request) && (metadata?.vision === 'unsupported' || metadata?.endpoint === 'openai_completion')) {
    throw new ModelFeatureError(`${model} does not support image input on this endpoint.`, 'enable_vision')
  }
  if (thinking !== undefined && metadata?.endpoint === 'openai_completion') {
    throw new ModelFeatureError('The legacy completions endpoint does not support a thinking toggle. Use auto or a chat endpoint.')
  }
}

export function ollamaThinking(request: ModelFeatureInput, model: string): boolean | string | undefined {
  const enabled = explicitThinking(request)
  if (enabled === undefined) return undefined
  if (enabled === false) {
    if (/gpt-oss/i.test(model)) throw new ModelFeatureError(`${model} requires thinking; use auto/enabled or another model.`)
    return false
  }
  const effort = typeof request.think === 'string' ? request.think : request.reasoning_effort
  if (/gpt-oss/i.test(model)) return effort === 'low' || effort === 'high' ? effort : effort === 'max' || effort === 'xhigh' ? 'high' : 'medium'
  return typeof effort === 'string' && levels.has(effort) ? effort : true
}

/** Translate only at the transport boundary: the same model can have different hosting protocols. */
export function openAIThinkingFields(request: ModelFeatureInput, model: string, endpoint: string, ollama = false): Record<string, unknown> {
  const enabled = explicitThinking(request)
  if (enabled === undefined) return {}
  if (ollama) {
    const think = ollamaThinking(request, model)
    return { reasoning_effort: think === false ? 'none' : think === true ? 'medium' : think }
  }
  let host = ''
  try { host = new URL(endpoint).hostname.toLowerCase() } catch { /* Custom relative endpoints use standard fields. */ }
  if (/dashscope|aliyuncs|qwencloud/.test(host)) return { enable_thinking: enabled }
  if (/minimax\.(io|com)|minimaxi\.com/.test(host)) {
    if (/^minimax-m3(?:\b|-)/i.test(model)) return { thinking: { type: enabled ? 'adaptive' : 'disabled' } }
    if (!enabled) throw new ModelFeatureError(`${model} on MiniMax does not support disabling thinking.`)
    return {}
  }
  if (/deepseek\.com|bigmodel\.cn|z\.ai|moonshot\.(ai|cn)|kimi\.(com|ai)|xiaomimimo\.com|mimo\.mi\.com/.test(host)) {
    return {
      thinking: { ...(typeof request.thinking === 'object' ? request.thinking : {}), type: enabled ? 'enabled' : 'disabled' },
      ...(enabled && request.reasoning_effort && request.reasoning_effort !== 'none' ? { reasoning_effort: request.reasoning_effort } : {}),
    }
  }
  // Preserve explicitly supplied native dialects for custom compatible hosts.
  if (request.chat_template_kwargs) {
    const template = request.chat_template_kwargs
    return { chat_template_kwargs: {
      ...template,
      ...(template.thinking !== undefined ? { thinking: enabled } : {}),
      ...(template.enable_thinking !== undefined ? { enable_thinking: enabled } : {}),
    } }
  }
  if (typeof request.thinking === 'object') return { thinking: { ...request.thinking, type: enabled ? request.thinking.type === 'disabled' ? 'enabled' : request.thinking.type : 'disabled' } }
  if (request.enable_thinking !== undefined && /qwen/i.test(model)) return { enable_thinking: enabled }
  return { reasoning_effort: enabled ? request.reasoning_effort && request.reasoning_effort !== 'none' ? request.reasoning_effort : 'medium' : 'none' }
}
