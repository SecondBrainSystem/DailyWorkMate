import { createHash } from 'node:crypto'
import { explicitThinking } from '../../shared/modelFeatures'
import type { ChatCompletionRequest, ChatCompletionTool, ForwardResult } from '../proxy/types'
import { OPENCODE_INFERENCE_BASE_URL, OPENCODE_PUBLIC_API_KEY, OpenCodeModelError,
  resolveOpenCodeFreeModel, type OpenCodeFreeModel } from '../companion/opencodeModels'
import { OPENCODE_COMPAT_TOOLS } from './opencodeToolDefinitions'
import { forwardFreeChat, type FreeChatWire } from './freeTransport'

/** Stable across turns and restarts. A rate limit never rotates this identity. */
export function openCodeProxySession(request: ChatCompletionRequest, headers: Record<string, unknown> = {}): string {
  const input = request as ChatCompletionRequest & { session_id?: unknown; sessionId?: unknown }
  const hint = headers['x-opencode-session-id'] ?? headers['x-opencode-session'] ?? headers['x-session-id']
    ?? input.session_id ?? input.sessionId
  if (hint !== undefined && (typeof hint !== 'string' || !hint.trim() || hint.length > 256 || /[\x00-\x1f\x7f]/.test(hint))) {
    throw new OpenCodeModelError('Invalid conversation session ID', 400)
  }
  // Client keys are hashed locally, never forwarded. Without an explicit session,
  // the first user turn anchors a stateless client's subsequent full-history turns.
  const digest = createHash('sha256').update(JSON.stringify([
    headers.authorization ?? headers['x-api-key'] ?? '', request.user ?? '',
    hint ?? request.messages.find(message => message.role === 'user')?.content ?? '',
  ])).digest()
  const timestamp = (~((BigInt('0x' + digest.subarray(0, 5).toString('hex')) >> 4n) << 12n | 1n) & 0xffffffffffffn)
    .toString(16).padStart(12, '0')
  let suffix = '', number = BigInt('0x' + digest.subarray(6, 16).toString('hex'))
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
  for (let i = 0; i < 14; i++) { suffix = alphabet[Number(number % 62n)] + suffix; number /= 62n }
  return 'ses_' + timestamp + suffix
}

/** Future non-chat protocols remain available in the native runtime until adapted here. */
export function supportsOpenCodeProxy(model: OpenCodeFreeModel): boolean { return model.protocol === 'chat-completions' }

export async function resolveOpenCodeProxyModel(id: string): Promise<OpenCodeFreeModel> {
  const model = await resolveOpenCodeFreeModel(id)
  if (!supportsOpenCodeProxy(model)) throw new OpenCodeModelError('该 OpenCode 模型的协议尚未支持公共转发，请使用原生 OpenCode 入口。 / This model requires the native OpenCode connection.', 400)
  return model
}

export function buildOpenCodeWire(request: ChatCompletionRequest, model: OpenCodeFreeModel,
  headers: Record<string, unknown> = {}): FreeChatWire {
  if (!supportsOpenCodeProxy(model)) throw new OpenCodeModelError('Unsupported OpenCode proxy protocol', 400)
  if (request.n !== undefined && request.n !== 1) throw new OpenCodeModelError('OpenCode free proxy supports n = 1', 400)
  if (request.web_search || request.web_search_options || request.deep_research) throw new OpenCodeModelError('OpenCode free proxy does not support search or deep research parameters', 400)
  if (request.tools?.length && !model.toolCall) throw new OpenCodeModelError('This OpenCode model does not support tools', 400)
  if (!model.vision && request.messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'))) {
    throw new OpenCodeModelError('This OpenCode model does not support images', 400)
  }
  const thinking = explicitThinking(request)
  if (thinking === true && !model.reasoning) throw new OpenCodeModelError('This OpenCode model does not support reasoning', 400)
  const max = request.max_completion_tokens ?? request.max_tokens ?? Math.min(8192, model.outputLimit)
  if (!Number.isSafeInteger(max) || max < 1) throw new OpenCodeModelError('max_tokens must be a positive integer', 400)

  const originalTools = request.tools || []
  if ((request.tool_choice === 'required' && !originalTools.length)
    || (typeof request.tool_choice === 'object' && !originalTools.some(tool => tool.function.name === (request.tool_choice as { function: { name: string } }).function.name))) {
    throw new OpenCodeModelError('tool_choice must refer to a tool supplied by the client', 400)
  }
  const usedNames = new Set(originalTools.map(tool => tool.function.name))
  if (usedNames.size !== originalTools.length) throw new OpenCodeModelError('Duplicate tool names are not supported', 400)
  const renamed = new Map<string, string>()
  const tools = originalTools.map((tool): ChatCompletionTool => {
    const name = tool.function.name, definition = Object.hasOwn(OPENCODE_COMPAT_TOOLS, name) ? OPENCODE_COMPAT_TOOLS[name] : undefined
    if (!definition || (tool.function.description === definition.description
      && JSON.stringify(tool.function.parameters) === JSON.stringify(definition.parameters))) return tool
    let alias = name + '_client'
    for (let index = 2; usedNames.has(alias); index++) alias = name + '_client' + index
    usedNames.add(alias); renamed.set(name, alias)
    return { ...tool, function: { ...tool.function, name: alias } }
  })
  const injected = Object.entries(OPENCODE_COMPAT_TOOLS).filter(([name]) => !tools.some(tool => tool.function.name === name))
  const note = [
    injected.length ? `Do not call ${injected.map(([name]) => name).join(' or ')}; these are protocol placeholders. Use only the other tools supplied by the caller.` : '',
    request.tool_choice === 'none' || !originalTools.length ? 'Answer directly without calling any tools.' : '',
  ].filter(Boolean).join('\n')
  const choice = request.tool_choice
  const selectedChoice = typeof choice === 'object' ? { ...choice, function: { ...choice.function,
    name: renamed.get(choice.function.name) || choice.function.name } } : choice
  const messages = request.messages.map(message => ({ ...message,
    ...(message.tool_calls ? { tool_calls: message.tool_calls.map(call => ({ ...call,
      function: { ...call.function, name: renamed.get(call.function.name) || call.function.name } })) } : {}),
  }))
  const fields = ['top_p', 'stop', 'seed', 'response_format', 'presence_penalty', 'frequency_penalty', 'parallel_tool_calls'] as const
  const session = openCodeProxySession(request, headers)
  const restored = new Map([...renamed].map(([original, alias]) => [alias, original]))
  const allowed = new Set(tools.map(tool => tool.function.name))
  type ToolCall = { id: string; name: string; arguments: string }
  let pending: ReadonlyMap<number, ToolCall> = new Map(), size = 0
  const transformPacket = (packet: any) => ({ ...packet, choices: packet.choices.map((entry: any) => {
    const { tool_calls: calls, ...delta } = entry.delta || {}
    for (const call of calls || []) {
      const index = call.index ?? 0
      if (!Number.isSafeInteger(index) || index < 0 || index > 128) throw new OpenCodeModelError('Invalid OpenCode tool index', 502)
      size += JSON.stringify(call).length
      if (size > 4 * 1024 * 1024) throw new OpenCodeModelError('OpenCode tool output exceeds 4 MiB', 502)
      const previous = pending.get(index)
      pending = new Map([...pending, [index, { id: call.id || previous?.id || '',
        name: (previous?.name || '') + (call.function?.name || ''),
        arguments: (previous?.arguments || '') + (call.function?.arguments || '') }]])
    }
    if (!entry.finish_reason) return { ...entry, delta }
    if (!pending.size) {
      if (choice === 'required' || typeof choice === 'object') throw new OpenCodeModelError('OpenCode did not return the required client tool call', 502)
      return { ...entry, delta }
    }
    // Hold tool fragments until their full names can be checked; never expose injected tools.
    const completed = [...pending].sort(([a], [b]) => a - b).map(([index, call]) => {
      if (request.tool_choice === 'none' || !allowed.has(call.name)
        || (typeof selectedChoice === 'object' && selectedChoice.function.name !== call.name)) {
        throw new OpenCodeModelError('OpenCode 返回了客户端未授权的工具调用；代理未执行任何工具。 / OpenCode returned an undeclared tool. No tool was executed.', 502)
      }
      return { index, id: call.id, type: 'function', function: { name: restored.get(call.name) || call.name, arguments: call.arguments } }
    })
    pending = new Map()
    return { ...entry, delta: { ...delta, tool_calls: completed } }
  }) })
  return {
    url: OPENCODE_INFERENCE_BASE_URL + '/chat/completions',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: 'Bearer ' + OPENCODE_PUBLIC_API_KEY,
      'User-Agent': 'opencode/latest/2.0.26/cli', 'x-opencode-client': 'cli', 'x-opencode-project': 'global',
      'x-opencode-session': session, 'x-opencode-session-id': session, 'x-session-affinity': session, 'x-session-id': session },
    body: {
      ...Object.fromEntries(fields.flatMap(key => request[key] === undefined ? [] : [[key, request[key]]])),
      model: model.apiModel, messages: [...(note ? [{ role: 'system', content: note }] : []), ...messages],
      tools: [...tools, ...injected.map(([name, definition]) => ({ type: 'function', function: { name, ...structuredClone(definition) } }))],
      ...(selectedChoice && selectedChoice !== 'none' ? { tool_choice: selectedChoice } : {}),
      ...(model.temperature && request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(model.reasoning && (thinking !== undefined || request.reasoning_effort) ? {
        reasoning_effort: thinking === false ? 'none' : request.reasoning_effort || 'high',
      } : {}),
      max_tokens: Math.min(max, model.outputLimit), stream: true, stream_options: { include_usage: true },
    },
    transformPacket,
    finalize: () => { if (pending.size) throw new OpenCodeModelError('OpenCode tool call ended before completion', 502) },
  }
}

export function forwardOpenCodeCompletion(request: ChatCompletionRequest, headers: Record<string, unknown> = {},
  signal?: AbortSignal, timeout = 120_000,
  dependencies: { fetch?: typeof fetch; resolve?: (id: string) => Promise<OpenCodeFreeModel> } = {}): Promise<ForwardResult> {
  return forwardFreeChat(request, { label: 'OpenCode', code: 'opencode', fetch: dependencies.fetch,
    prepare: async () => buildOpenCodeWire(request, await (dependencies.resolve ?? resolveOpenCodeProxyModel)(request.model), headers),
  }, signal, timeout)
}
