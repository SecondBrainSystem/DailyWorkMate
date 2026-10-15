import { Transform } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { jsonSseTransform } from './jsonSseTransform.ts'
import type { ChatCompletionRequest, ChatMessage } from './types'
import { ModelFeatureError, normalizeFeatureRequest, ollamaThinking } from './modelFeatures.ts'
import { explicitThinking } from '../../shared/modelFeatures.ts'

function id(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function timestamp(value?: string): number {
  if (!value) return Math.floor(Date.now() / 1000)
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? Math.floor(Date.now() / 1000) : Math.floor(parsed / 1000)
}

function normalizeImage(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const match = value.match(/^data:[^,]+;base64,(.+)$/i)
  const base64 = match ? match[1] : value
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 !== 0) {
    throw new ModelFeatureError('Ollama image input requires base64 data; use a data:image/...;base64 URL instead of an HTTP URL.', 'messages')
  }
  return base64
}

function contentAndImages(content: ChatMessage['content']): { content: string; images: string[] } {
  if (typeof content === 'string') return { content, images: [] }
  if (!Array.isArray(content)) return { content: '', images: [] }
  const texts: string[] = []
  const images: string[] = []
  for (const part of content) {
    if (part.type === 'text' && part.text) texts.push(part.text)
    if (part.type === 'image_url') {
      const image = normalizeImage(part.image_url?.url)
      if (image) images.push(image)
    }
  }
  return { content: texts.join('\n'), images }
}

function requestOptions(request: ChatCompletionRequest | Record<string, any>): Record<string, unknown> {
  const rawOptions = (request as any).options
  const options: Record<string, unknown> = rawOptions && typeof rawOptions === 'object' && !Array.isArray(rawOptions) ? { ...rawOptions } : {}
  if (request.temperature !== undefined) options.temperature = request.temperature
  if (request.top_p !== undefined) options.top_p = request.top_p
  if (request.presence_penalty !== undefined) options.presence_penalty = request.presence_penalty
  if (request.frequency_penalty !== undefined) options.frequency_penalty = request.frequency_penalty
  const maxTokens = (request as any).max_completion_tokens ?? request.max_tokens
  if (maxTokens !== undefined) options.num_predict = maxTokens
  if ((request as any).seed !== undefined) options.seed = (request as any).seed
  if (request.stop !== undefined) options.stop = Array.isArray(request.stop) ? request.stop : [request.stop]
  return options
}

export function openAIToOllamaChat(request: ChatCompletionRequest, model: string): Record<string, unknown> {
  request = normalizeFeatureRequest(request)
  if (request.n !== undefined && request.n !== 1) throw new ModelFeatureError('Ollama native endpoints support only n=1', 'n')
  if (request.tool_choice && request.tool_choice !== 'auto' && request.tool_choice !== 'none') {
    throw new ModelFeatureError('Ollama native chat cannot enforce tool_choice; use auto or none.', 'tool_choice')
  }
  const toolNames = new Map<string, string>()
  const messages = request.messages.map(message => {
    const extracted = contentAndImages(message.content)
    const translated: Record<string, unknown> = {
      role: message.role,
      content: extracted.content,
    }
    if (extracted.images.length > 0) translated.images = extracted.images
    if (message.reasoning_content !== undefined) translated.thinking = message.reasoning_content
    if (message.role === 'tool') {
      const name = message.name || toolNames.get(message.tool_call_id || '')
      if (!name) throw new ModelFeatureError('Tool result does not match a preceding tool call', 'messages')
      translated.tool_name = name
    }
    if (message.tool_calls) {
      translated.tool_calls = message.tool_calls.map(call => {
        toolNames.set(call.id, call.function.name)
        return { function: { name: call.function.name, arguments: JSON.parse(call.function.arguments) } }
      })
    }
    return translated
  })
  const payload: Record<string, unknown> = { model, messages, stream: Boolean(request.stream) }
  if (request.tools?.length && request.tool_choice !== 'none') payload.tools = request.tools
  const options = requestOptions(request)
  if (Object.keys(options).length > 0) payload.options = options
  const responseFormat = (request as any).response_format
  if (responseFormat?.type === 'json_object') payload.format = 'json'
  if (responseFormat?.type === 'json_schema') payload.format = responseFormat.json_schema?.schema || 'json'
  const think = ollamaThinking(request, model)
  if (think !== undefined) payload.think = think
  if ((request as any).format !== undefined) payload.format = (request as any).format
  if ((request as any).keep_alive !== undefined) payload.keep_alive = (request as any).keep_alive
  return payload
}

export function openAIToOllamaGenerate(request: ChatCompletionRequest, model: string): Record<string, unknown> {
  request = normalizeFeatureRequest(request)
  validateTextCompletionTools(request)
  const prompt = request.messages.map(message => {
    const extracted = contentAndImages(message.content)
    return `${message.role.toUpperCase()}: ${extracted.content}`
  }).join('\n\n')
  const payload: Record<string, unknown> = { model, prompt, stream: Boolean(request.stream) }
  const images = request.messages.flatMap(message => contentAndImages(message.content).images)
  if (images.length) payload.images = images
  const chatPayload = openAIToOllamaChat(request, model)
  for (const key of ['think', 'format', 'keep_alive']) {
    if (chatPayload[key] !== undefined) payload[key] = chatPayload[key]
  }
  const options = requestOptions(request)
  if (Object.keys(options).length > 0) payload.options = options
  return payload
}

export function validateTextCompletionTools(request: ChatCompletionRequest): void {
  if ((request.tools?.length && request.tool_choice !== 'none')
    || request.messages.some(message => message.role === 'tool' || message.tool_calls?.length)) {
    throw new ModelFeatureError('This completion endpoint cannot preserve tool calls; select a chat endpoint.', 'tools')
  }
}

export function ollamaChatToOpenAI(data: any, fallbackModel: string): Record<string, unknown> {
  const message = data?.message || {}
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls.map((call: any) => ({
        id: id('call'),
        type: 'function',
        function: {
          name: call?.function?.name || '',
          arguments: typeof call?.function?.arguments === 'string'
            ? call.function.arguments
            : JSON.stringify(call?.function?.arguments || {}),
        },
      }))
    : undefined
  const thinking = message.thinking || ''
  return {
    id: id('chatcmpl'),
    object: 'chat.completion',
    created: timestamp(data?.created_at),
    model: data?.model || fallbackModel,
    choices: [{
      index: 0,
      message: {
        role: message.role || 'assistant',
        content: message.content || '',
        ...(thinking ? { reasoning_content: thinking } : {}),
        ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: toolCalls?.length ? 'tool_calls' : data?.done_reason || 'stop',
    }],
    usage: usageFromOllama(data),
  }
}

export function ollamaGenerateToOpenAI(data: any, fallbackModel: string): Record<string, unknown> {
  return {
    id: id('chatcmpl'),
    object: 'chat.completion',
    created: timestamp(data?.created_at),
    model: data?.model || fallbackModel,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: data?.response || '', ...(data?.thinking ? { reasoning_content: data.thinking } : {}) },
      finish_reason: data?.done_reason || 'stop',
    }],
    usage: usageFromOllama(data),
  }
}

export function openAIToClaudeRequest(request: ChatCompletionRequest, model: string): Record<string, unknown> {
  request = normalizeFeatureRequest(request)
  const system: string[] = []
  const messages: Array<Record<string, unknown>> = []
  for (const message of request.messages) {
    const text = typeof message.content === 'string' ? message.content : Array.isArray(message.content)
      ? message.content.filter(part => part.type === 'text').map(part => part.text || '').join('\n') : ''
    if (message.role === 'system') {
      system.push(text)
      continue
    }
    if (message.role === 'tool') {
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: text }] })
      continue
    }
    const content: Array<Record<string, unknown>> = Array.isArray(message.content)
      ? message.content.map(part => {
          if (part.type === 'text') return { type: 'text', text: part.text || '' }
          const url = part.image_url?.url || ''
          const data = url.match(/^data:(image\/[^;,]+);base64,(.+)$/)
          if (data) return { type: 'image', source: { type: 'base64', media_type: data[1], data: data[2] } }
          if (!/^https?:\/\//i.test(url)) throw new ModelFeatureError('Claude image input requires an HTTP URL or a data URL with an image MIME type.', 'messages')
          return { type: 'image', source: { type: 'url', url } }
        })
      : text ? [{ type: 'text', text }] : []
    messages.push({ role: message.role, content: [
      ...content,
      ...(message.tool_calls || []).map(call => ({ type: 'tool_use', id: call.id, name: call.function.name, input: parseJsonOrString(call.function.arguments) })),
    ] })
  }
  const enabled = explicitThinking(request)
  const maxTokens = request.max_completion_tokens ?? request.max_tokens ?? (enabled ? 4096 : 1024)
  const nativeThinking = typeof request.thinking === 'object' ? request.thinking : undefined
  const budget = nativeThinking?.budget_tokens ?? Math.min(1024, maxTokens - 1)
  const adaptive = nativeThinking?.type === 'adaptive' || /claude.*(?:opus|sonnet)[-.]4[-.]6/.test(model)
  if (enabled && !adaptive && budget < 1024) throw new ModelFeatureError('Claude thinking needs max_tokens > 1024 and a thinking budget of at least 1024.', 'max_tokens')
  if (enabled && !adaptive && budget >= maxTokens) throw new ModelFeatureError('thinking.budget_tokens must be smaller than max_tokens.', 'thinking')
  return {
    model,
    system: system.join('\n\n') || undefined,
    messages,
    max_tokens: maxTokens,
    ...(enabled ? {} : { temperature: request.temperature, top_p: request.top_p }),
    ...(enabled === undefined ? {} : { thinking: enabled ? adaptive ? { type: 'adaptive' } : { type: 'enabled', budget_tokens: budget } : { type: 'disabled' } }),
    stream: Boolean(request.stream),
    stop_sequences: typeof request.stop === 'string' ? [request.stop] : request.stop,
    tool_choice: request.tool_choice === undefined ? undefined
      : typeof request.tool_choice === 'object' ? { type: 'tool', name: request.tool_choice.function.name }
      : { type: request.tool_choice === 'required' ? 'any' : request.tool_choice },
    tools: request.tools?.map(tool => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters || {},
    })),
  }
}

export function claudeToOpenAIResponse(data: any, fallbackModel: string): Record<string, unknown> {
  const blocks = Array.isArray(data?.content) ? data.content : []
  const text = blocks.filter((block: any) => block?.type === 'text').map((block: any) => block.text || '').join('')
  const thinking = blocks.filter((block: any) => block?.type === 'thinking').map((block: any) => block.thinking || '').join('')
  const toolCalls = blocks.filter((block: any) => block?.type === 'tool_use').map((block: any) => ({
    id: block.id || id('call'),
    type: 'function',
    function: { name: block.name || '', arguments: JSON.stringify(block.input || {}) },
  }))
  return {
    id: id('chatcmpl'),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: data?.model || fallbackModel,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text, ...(thinking ? { reasoning_content: thinking } : {}), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
      finish_reason: toolCalls.length ? 'tool_calls' : data?.stop_reason === 'max_tokens' ? 'length' : 'stop',
    }],
    usage: {
      prompt_tokens: data?.usage?.input_tokens || 0,
      completion_tokens: data?.usage?.output_tokens || 0,
      total_tokens: (data?.usage?.input_tokens || 0) + (data?.usage?.output_tokens || 0),
    },
  }
}

function validateNativeRequest(request: any): void {
  if (!request || typeof request !== 'object' || typeof request.model !== 'string' || !request.model.trim()
    || !Array.isArray(request.messages) || !request.messages.length) {
    throw new ModelFeatureError('model and non-empty messages are required', 'messages')
  }
  if (request.stream !== undefined && typeof request.stream !== 'boolean') throw new ModelFeatureError('stream must be a boolean', 'stream')
  for (const message of request.messages) {
    if (!message || !['user', 'assistant', 'system', 'tool'].includes(message.role)) throw new ModelFeatureError('Invalid message role', 'messages')
  }
}

export function claudeRequestToOpenAI(request: any): ChatCompletionRequest {
  validateNativeRequest(request)
  const choice = request.tool_choice
  if (choice !== undefined && (!choice || typeof choice !== 'object'
    || !['auto', 'any', 'none', 'tool'].includes(choice.type)
    || (choice.type === 'tool' && (typeof choice.name !== 'string' || !choice.name.trim())))) {
    throw new ModelFeatureError('Invalid Claude tool_choice', 'tool_choice')
  }
  const messages: ChatMessage[] = []
  if (typeof request?.system === 'string' && request.system) {
    messages.push({ role: 'system', content: request.system })
  }
  if (Array.isArray(request.system)) {
    if (request.system.some((part: any) => part?.type !== 'text' || typeof part.text !== 'string')) throw new ModelFeatureError('Invalid system content', 'system')
    messages.push({ role: 'system', content: request.system.map((part: any) => part.text).join('\n') })
  }
  // Claude Code sends context such as its environment as `system` messages inside the conversation.
  // Many chat templates accept a system turn only first, so their text joins the leading system prompt.
  const contextual: string[] = []
  for (const item of Array.isArray(request?.messages) ? request.messages : []) {
    if (!['user', 'assistant', 'system'].includes(item.role) || (typeof item.content !== 'string' && !Array.isArray(item.content))) throw new ModelFeatureError('Invalid Claude message', 'messages')
    if (item.role === 'system') {
      if (Array.isArray(item.content) && item.content.some((part: any) => part?.type !== 'text' || typeof part.text !== 'string')) throw new ModelFeatureError('Invalid system content', 'messages')
      const text = typeof item.content === 'string' ? item.content : item.content.map((part: any) => part.text).join('\n')
      if (text) contextual.push(text)
      continue
    }
    if (typeof item?.content === 'string') {
      messages.push({ role: item?.role === 'assistant' ? 'assistant' : 'user', content: item.content })
      continue
    }
    const parts = Array.isArray(item?.content) ? item.content : []
    const content = parts.flatMap((part: any) => {
      if (!part || typeof part !== 'object') throw new ModelFeatureError('Invalid content block', 'messages')
      if (part?.type === 'text') return [{ type: 'text' as const, text: part.text || '' }]
      if (part?.type === 'image') {
        const source = part?.source
        if (!source || (source.type !== 'base64' && source.type !== 'url')) throw new ModelFeatureError('Invalid Claude image source', 'messages')
        if (source.type === 'base64' && (!/^image\/(png|jpeg|gif|webp)$/.test(source.media_type) || typeof source.data !== 'string' || !source.data)) throw new ModelFeatureError('Invalid Claude base64 image', 'messages')
        const url = source.type === 'base64' ? `data:${source.media_type};base64,${source.data}` : source.url
        return [{ type: 'image_url' as const, image_url: { url } }]
      }
      return []
    })
    const toolCalls = parts.filter((part: any) => part?.type === 'tool_use').map((part: any) => ({
      id: part.id || id('call'),
      type: 'function' as const,
      function: { name: part.name || '', arguments: JSON.stringify(part.input || {}) },
    }))
    // Tool results answer the previous assistant turn; OpenAI-compatible upstreams reject a user
    // message between tool_calls and their results, so text in the same Claude turn goes after them.
    for (const part of parts.filter((candidate: any) => candidate?.type === 'tool_result')) {
      const resultContent = typeof part.content === 'string'
        ? part.content
        : (Array.isArray(part.content) ? part.content : [])
            .filter((nested: any) => nested?.type === 'text')
            .map((nested: any) => nested.text || '')
            .join('\n')
      messages.push({
        role: 'tool',
        tool_call_id: part.tool_use_id || '',
        content: resultContent,
      })
    }
    if (content.length > 0 || toolCalls.length > 0) {
      messages.push({
        role: item?.role === 'assistant' ? 'assistant' : 'user',
        content: content.length > 0 ? content : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      })
    }
  }
  if (contextual.length) {
    const leading = messages[0]?.role === 'system' ? messages[0] : undefined
    if (leading) messages[0] = { ...leading, content: [leading.content, ...contextual].join('\n\n') }
    else messages.unshift({ role: 'system', content: contextual.join('\n\n') })
  }
  return {
    ...request,
    // "adaptive" lets the model decide. Forcing thinking on (e.g. Ollama `think: true`) fails on
    // models without it, so only an explicit enabled/disabled choice is forwarded.
    thinking: request.thinking?.type === 'adaptive' ? undefined : request.thinking,
    model: request?.model || '',
    messages,
    max_tokens: request?.max_tokens,
    temperature: request?.temperature,
    top_p: request?.top_p,
    stop: request?.stop_sequences,
    stream: request?.stream ?? false,
    tool_choice: choice === undefined ? undefined : choice.type === 'tool'
      ? { type: 'function', function: { name: choice.name } }
      : choice.type === 'any' ? 'required' : choice.type,
    tools: Array.isArray(request?.tools) ? request.tools.map((tool: any) => ({
      type: 'function' as const,
      function: {
        name: tool?.name || '',
        description: tool?.description,
        parameters: tool?.input_schema || {},
      },
    })) : undefined,
  }
}

export function openAIResponseToClaude(data: any, fallbackModel: string): Record<string, unknown> {
  const choice = data?.choices?.[0] || {}
  const message = choice.message || {}
  const content: Array<Record<string, unknown>> = []
  if (message.reasoning_content) content.push({ type: 'thinking', thinking: message.reasoning_content })
  if (message.content) content.push({ type: 'text', text: message.content })
  for (const call of message.tool_calls || []) {
    content.push({
      type: 'tool_use',
      id: call.id || id('toolu'),
      name: call.function?.name || '',
      input: parseJsonOrString(call.function?.arguments || '{}'),
    })
  }
  return {
    id: id('msg'),
    type: 'message',
    role: 'assistant',
    model: data?.model || fallbackModel,
    content,
    stop_reason: message.tool_calls?.length ? 'tool_use' : choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: data?.usage?.prompt_tokens || 0,
      output_tokens: data?.usage?.completion_tokens || 0,
    },
  }
}

export function ollamaRequestToOpenAI(request: any): ChatCompletionRequest {
  validateNativeRequest(request)
  if (request.options !== undefined && (!request.options || typeof request.options !== 'object' || Array.isArray(request.options))) {
    throw new ModelFeatureError('options must be an object', 'options')
  }
  if (request.format !== undefined && request.format !== 'json' && request.format !== ''
    && (!request.format || typeof request.format !== 'object' || Array.isArray(request.format))) {
    throw new ModelFeatureError('format must be json or a JSON schema object', 'format')
  }
  for (const message of request.messages) {
    if (message.images !== undefined && (!Array.isArray(message.images) || message.images.some((image: unknown) => typeof image !== 'string' || !image))) throw new ModelFeatureError('images must be an array of base64 strings', 'messages')
    if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) throw new ModelFeatureError('tool_calls must be an array', 'messages')
    if (message.content !== undefined && typeof message.content !== 'string') throw new ModelFeatureError('Ollama content must be text', 'messages')
  }
  let pending: Array<{ id: string; name: string }> = []
  const messages: ChatMessage[] = request.messages.map((message: any) => {
    const calls = message.tool_calls?.map((call: any) => {
      if (typeof call?.function?.name !== 'string' || !call.function.name.trim()) {
        throw new ModelFeatureError('Invalid Ollama tool call function name', 'messages')
      }
      const callId = call.id || id('call')
      pending = [...pending, { id: callId, name: call.function.name }]
      return { id: callId, type: 'function' as const, function: {
        name: call.function.name,
        arguments: typeof call.function.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function.arguments ?? {}),
      } }
    })
    let toolResult: Pick<ChatMessage, 'tool_call_id' | 'name'> = {}
    if (message.role === 'tool') {
      const index = pending.findIndex(call => message.tool_call_id ? call.id === message.tool_call_id : !message.tool_name || call.name === message.tool_name)
      if (index < 0) throw new ModelFeatureError('Tool result does not match a preceding tool call', 'messages')
      toolResult = { tool_call_id: pending[index].id, name: pending[index].name }
      pending = pending.filter((_, candidate) => candidate !== index)
    }
    return {
      role: message.role,
      content: message.images?.length ? [
        { type: 'text', text: message.content || '' },
        ...message.images.map((value: string) => {
          const base64 = normalizeImage(value)!
          const bytes = Buffer.from(base64, 'base64')
          const mime = bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg'
            : bytes.subarray(0, 3).toString() === 'GIF' ? 'image/gif'
              : bytes.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : 'image/png'
          return { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } }
        }),
      ] : message.content || '',
      ...(calls ? { tool_calls: calls } : {}),
      ...(message.thinking !== undefined ? { reasoning_content: message.thinking } : {}),
      ...toolResult,
    }
  })
  return normalizeFeatureRequest({
    ...request,
    model: request?.model || '',
    messages,
    stream: request?.stream === undefined ? true : request.stream,
    tools: request?.tools,
    temperature: request?.options?.temperature,
    top_p: request?.options?.top_p,
    max_tokens: request?.options?.num_predict,
    stop: request?.options?.stop,
    seed: request.options?.seed,
    frequency_penalty: request.options?.frequency_penalty,
    presence_penalty: request.options?.presence_penalty,
    ...(request.format === 'json' ? { response_format: { type: 'json_object' } }
      : request.format && typeof request.format === 'object'
        ? { response_format: { type: 'json_schema', json_schema: { name: 'response', schema: request.format } } } : {}),
  })
}

export function openAIResponseToOllama(data: any, fallbackModel: string): Record<string, unknown> {
  const choice = data?.choices?.[0] || {}
  const message = choice.message || {}
  return {
    model: data?.model || fallbackModel,
    created_at: new Date().toISOString(),
    message: {
      role: 'assistant',
      content: message.content || '',
      ...(message.reasoning_content ? { thinking: message.reasoning_content } : {}),
      ...(message.tool_calls?.length ? {
        tool_calls: message.tool_calls.map((call: any) => ({
          function: {
            name: call.function?.name || '',
            arguments: parseJsonOrString(call.function?.arguments || '{}'),
          },
        })),
      } : {}),
    },
    done: true,
    done_reason: choice.finish_reason === 'length' ? 'length' : 'stop',
    prompt_eval_count: data?.usage?.prompt_tokens || 0,
    eval_count: data?.usage?.completion_tokens || 0,
  }
}

function usageFromOllama(data: any): Record<string, number> {
  const prompt = data?.prompt_eval_count || 0
  const completion = data?.eval_count || 0
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion }
}

function parseJsonOrString(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

export function createOllamaNdjsonToOpenAIStream(model: string): Transform {
  let buffer = ''
  let sentRole = false
  let finished = false
  let hasToolCalls = false
  let nextToolIndex = 0
  // Counted for the truncation message, so users can tell an empty reply from a cut-off one.
  let events = 0
  let bytes = 0
  let produced = false
  const decoder = new StringDecoder('utf8')
  const completionId = id('chatcmpl')
  const created = Math.floor(Date.now() / 1000)
  const consume = (target: Transform, line: string) => {
    if (!line.trim() || finished) return
    if (line.length > 4 * 1024 * 1024) throw new Error('Ollama stream event exceeds the 4 MiB limit')
    const data = JSON.parse(line)
    events += 1
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid Ollama stream event')
    if (data.error) {
      target.push(`data: ${JSON.stringify({ error: { message: typeof data.error === 'string' ? data.error : data.error.message || 'Ollama stream failed' } })}\n\n`)
      target.push('data: [DONE]\n\n')
      finished = true
      target.push(null)
      return
    }
    const message = data.message || {}
    const emit = (delta: Record<string, unknown>, finishReason: string | null = null, usage?: Record<string, number>) => {
      target.push(`data: ${JSON.stringify({
        id: completionId, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
        ...(usage ? { usage } : {}),
      })}\n\n`)
    }
    if (!sentRole) { emit({ role: 'assistant' }); sentRole = true }
    const content = message.content ?? data.response
    const thinking = message.thinking ?? data.thinking
    if (message.tool_calls?.length) hasToolCalls = true
    if (content || thinking || message.tool_calls?.length) {
      produced = true
      emit({
        ...(content ? { content } : {}),
        ...(thinking ? { reasoning_content: thinking } : {}),
        ...(message.tool_calls?.length ? { tool_calls: message.tool_calls.map((call: any) => ({
          index: nextToolIndex++, id: id('call'), type: 'function', function: {
            name: call.function?.name || '',
            arguments: typeof call.function?.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function?.arguments || {}),
          },
        })) } : {}),
      })
    }
    if (data.done) {
      emit({}, hasToolCalls ? 'tool_calls' : data.done_reason || 'stop', usageFromOllama(data))
      target.push('data: [DONE]\n\n')
      finished = true
      target.push(null)
    }
  }
  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        bytes += data.length
        buffer += decoder.write(data)
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        if (buffer.length > 4 * 1024 * 1024) throw new Error('Ollama stream event exceeds the 4 MiB limit')
        for (const line of lines) consume(this, line)
        callback()
      } catch (error) { callback(error instanceof Error ? error : new Error(String(error))) }
    },
    flush(callback) {
      try {
        buffer += decoder.end()
        if (buffer.trim()) consume(this, buffer)
        if (!finished) {
          const received = `${events} event${events === 1 ? '' : 's'}, ${bytes} bytes`
          throw new Error(`Ollama stream ended before its done event (${received}${produced ? '' : ', no output'}); the node closed the response early`)
        }
        callback()
      } catch (error) { callback(error instanceof Error ? error : new Error(String(error))) }
    },
  })
}

export function createOpenAICompletionToChatStream(model: string): Transform {
  const completionId = id('chatcmpl')
  const created = Math.floor(Date.now() / 1000)
  let finished = false
  let hasFinishReason = false
  const finish = (target: Transform) => {
    if (finished) return
    if (!hasFinishReason) throw new Error('Completion stream ended before its finish event')
    target.push('data: [DONE]\n\n')
    finished = true
    target.push(null)
  }
  return jsonSseTransform((target, data) => {
    if (finished) return
    if (data === '[DONE]') { hasFinishReason = true; finish(target); return }
    if (data.error) { target.push(`data: ${JSON.stringify(data)}\n\n`); hasFinishReason = true; finish(target); return }
    const choice = data?.choices?.[0]
    if (choice?.finish_reason) hasFinishReason = true
    target.push(`data: ${JSON.stringify({
      id: completionId, object: 'chat.completion.chunk', created, model: data?.model || model,
      choices: choice ? [{ index: 0, delta: { ...(choice.text ? { content: choice.text } : {}) }, finish_reason: choice.finish_reason || null }] : [],
      ...(data?.usage ? { usage: data.usage } : {}),
    })}\n\n`)
  }, finish)
}

export function createValidatedOpenAIStream(): Transform {
  let finished = false
  let finishReason = false
  const finish = (target: Transform) => {
    if (finished) return
    if (!finishReason) throw new Error('OpenAI stream ended before its finish event')
    target.push('data: [DONE]\n\n')
    finished = true
    target.push(null)
  }
  return jsonSseTransform((target, data) => {
    if (finished) return
    if (data === '[DONE]') { finishReason = true; finish(target); return }
    if (!data || typeof data !== 'object' || (!data.error && !Array.isArray(data.choices))) {
      throw new Error('Invalid OpenAI stream event')
    }
    target.push(`data: ${JSON.stringify(data)}\n\n`)
    if (data.error) { finishReason = true; finish(target); return }
    if (data.choices.some((choice: any) => choice.finish_reason)) finishReason = true
  }, finish)
}

export function createClaudeToOpenAIStream(model: string): Transform {
  const completionId = id('chatcmpl')
  const created = Math.floor(Date.now() / 1000)
  const tools = new Map<number, number>()
  let finished = false
  let promptTokens = 0
  let completionTokens = 0
  const emit = (target: Transform, delta: Record<string, unknown>, reason: string | null = null, usage = false) => {
    target.push(`data: ${JSON.stringify({
      id: completionId, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta, finish_reason: reason }],
      ...(usage ? { usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens } } : {}),
    })}\n\n`)
  }
  return jsonSseTransform((target, data) => {
    if (finished || data === '[DONE]') return
    if (data.type === 'error' || data.error) {
      target.push(`data: ${JSON.stringify({ error: data.error || { message: 'Upstream Claude stream failed' } })}\n\n`)
      target.push('data: [DONE]\n\n')
      finished = true
      target.push(null)
      return
    }
    if (data.type === 'message_start') {
      promptTokens = data.message?.usage?.input_tokens || 0
      completionTokens = data.message?.usage?.output_tokens || 0
      emit(target, { role: 'assistant' })
    }
    if (data.type === 'content_block_start') {
      const block = data.content_block || {}
      if (block.type === 'text' && block.text) emit(target, { content: block.text })
      if (block.type === 'thinking' && block.thinking) emit(target, { reasoning_content: block.thinking })
      if (block.type === 'tool_use') {
        const index = tools.size
        tools.set(data.index, index)
        emit(target, { tool_calls: [{ index, id: block.id || id('call'), type: 'function', function: {
          name: block.name, arguments: block.input && Object.keys(block.input).length ? JSON.stringify(block.input) : '',
        } }] })
      }
    }
    if (data.type === 'content_block_delta') {
      const delta = data.delta || {}
      if (delta.type === 'text_delta') emit(target, { content: delta.text })
      if (delta.type === 'thinking_delta') emit(target, { reasoning_content: delta.thinking })
      if (delta.type === 'input_json_delta' && tools.has(data.index)) {
        emit(target, { tool_calls: [{ index: tools.get(data.index), function: { arguments: delta.partial_json } }] })
      }
    }
    if (data.type === 'message_delta') {
      completionTokens = data.usage?.output_tokens ?? completionTokens
      emit(target, {}, data.delta?.stop_reason === 'max_tokens' ? 'length' : data.delta?.stop_reason === 'tool_use' ? 'tool_calls' : 'stop', true)
    }
    if (data.type === 'message_stop') {
      target.push('data: [DONE]\n\n')
      finished = true
      target.push(null)
    }
  }, () => { if (!finished) throw new Error('Claude stream ended before message_stop') })
}

export function createOpenAISseToOllamaStream(model: string): Transform {
  let finished = false
  let finishReason = ''
  let usage: any = {}
  const tools = new Map<number, { name: string; arguments: string }>()
  const emit = (target: Transform, message: Record<string, unknown>, done = false) => target.push(`${JSON.stringify({
    model, created_at: new Date().toISOString(), message: { role: 'assistant', content: '', ...message }, done,
    ...(done ? { done_reason: finishReason === 'length' ? 'length' : 'stop', prompt_eval_count: usage.prompt_tokens || 0, eval_count: usage.completion_tokens || 0 } : {}),
  })}\n`)
  const finish = (target: Transform) => {
    if (finished) return
    if (!finishReason) throw new Error('OpenAI stream ended before its finish event')
    const toolCalls = Array.from(tools.values()).map(tool => ({ function: { name: tool.name, arguments: JSON.parse(tool.arguments || '{}') } }))
    emit(target, toolCalls.length ? { tool_calls: toolCalls } : {}, true)
    finished = true
    target.push(null)
  }
  return jsonSseTransform((target, data) => {
    if (finished) return
    if (data === '[DONE]') { finishReason ||= 'stop'; finish(target); return }
    if (data.error) { target.push(`${JSON.stringify({ error: typeof data.error === 'string' ? data.error : data.error.message || 'Upstream stream failed' })}\n`); finished = true; target.push(null); return }
    if (data.usage) usage = data.usage
    const choice = data.choices?.[0]
    if (!choice) return
    const delta = choice.delta || {}
    if (delta.content || delta.reasoning_content) emit(target, { content: delta.content || '', ...(delta.reasoning_content ? { thinking: delta.reasoning_content } : {}) })
    for (const call of delta.tool_calls || []) {
      const previous = tools.get(call.index || 0) || { name: '', arguments: '' }
      tools.set(call.index || 0, { name: previous.name + (call.function?.name || ''), arguments: previous.arguments + (call.function?.arguments || '') })
    }
    if (choice.finish_reason) finishReason = choice.finish_reason
  }, finish)
}

export function createOpenAISseToClaudeStream(model: string): Transform {
  const messageId = id('msg')
  const pendingTools = new Map<number, { id: string; name: string; arguments: string }>()
  let textBlock: number | undefined
  let thinkingBlock: number | undefined
  let nextBlock = 0
  let activeBlock: number | undefined
  const closedBlocks = new Set<number>()
  let started = false
  let finished = false
  let finishReason = ''
  let usage: any = {}
  const emit = (target: Transform, type: string, fields: Record<string, unknown> = {}) => target.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`)
  const startBlock = (target: Transform, content: Record<string, unknown>) => {
    if (activeBlock !== undefined && !closedBlocks.has(activeBlock)) { emit(target, 'content_block_stop', { index: activeBlock }); closedBlocks.add(activeBlock) }
    const index = nextBlock++
    activeBlock = index
    emit(target, 'content_block_start', { index, content_block: content })
    return index
  }
  const finish = (target: Transform) => {
    if (finished) return
    if (!finishReason) throw new Error('OpenAI stream ended before its finish event')
    for (const tool of pendingTools.values()) {
      const index = startBlock(target, { type: 'tool_use', id: tool.id, name: tool.name, input: {} })
      if (tool.arguments) emit(target, 'content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: tool.arguments } })
    }
    for (let index = 0; index < nextBlock; index++) if (!closedBlocks.has(index)) emit(target, 'content_block_stop', { index })
    emit(target, 'message_delta', {
      delta: { stop_reason: finishReason === 'length' ? 'max_tokens' : finishReason === 'tool_calls' ? 'tool_use' : 'end_turn', stop_sequence: null },
      usage: { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0 },
    })
    emit(target, 'message_stop'); finished = true
    target.push(null)
  }
  return jsonSseTransform((target, data) => {
    if (finished) return
    if (data === '[DONE]') { finishReason ||= 'stop'; finish(target); return }
    if (data.error) { emit(target, 'error', { error: typeof data.error === 'object' ? data.error : { type: 'api_error', message: String(data.error) } }); finished = true; target.push(null); return }
    if (data.usage) usage = data.usage
    if (!started) {
      emit(target, 'message_start', { message: { id: messageId, type: 'message', role: 'assistant', content: [], model, stop_reason: null, usage: { input_tokens: usage.prompt_tokens || 0, output_tokens: 0 } } })
      started = true
    }
    const choice = data.choices?.[0]
    if (!choice) return
    const delta = choice.delta || {}
    if (delta.reasoning_content) {
      if (thinkingBlock === undefined || closedBlocks.has(thinkingBlock)) thinkingBlock = startBlock(target, { type: 'thinking', thinking: '' })
      emit(target, 'content_block_delta', { index: thinkingBlock, delta: { type: 'thinking_delta', thinking: delta.reasoning_content } })
    }
    if (delta.content) {
      if (textBlock === undefined || closedBlocks.has(textBlock)) textBlock = startBlock(target, { type: 'text', text: '' })
      emit(target, 'content_block_delta', { index: textBlock, delta: { type: 'text_delta', text: delta.content } })
    }
    for (const call of delta.tool_calls || []) {
      const toolIndex = call.index || 0
      const previous = pendingTools.get(toolIndex) || { id: call.id || id('toolu'), name: '', arguments: '' }
      pendingTools.set(toolIndex, { id: call.id || previous.id, name: previous.name + (call.function?.name || ''), arguments: previous.arguments + (call.function?.arguments || '') })
    }
    if (choice.finish_reason) finishReason = choice.finish_reason
  }, finish)
}
