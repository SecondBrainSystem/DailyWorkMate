import type { AppConfig } from '@/types/electron'

export interface ChatApiMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | Array<{
    type: 'text' | 'image_url'
    text?: string
    image_url?: { url: string; detail: 'auto' }
  }>
}

export interface ChatStreamDelta {
  content?: string
  reasoning?: string
  /** Names of tools the model started calling in this chunk (later argument chunks have no name). */
  toolCalls?: string[]
}

interface ChatCompletionChunk {
  choices?: Array<{
    finish_reason?: string | null
    delta?: {
      content?: string
      reasoning_content?: string
      tool_calls?: Array<{ function?: { name?: string } }>
    }
  }>
  error?: string | { message?: string }
}

export function resolveLocalProxyBaseUrl(config: Pick<AppConfig, 'proxyHost' | 'proxyPort'>): string {
  const configuredHost = config.proxyHost?.trim() || '127.0.0.1'
  const localHost = configuredHost === '0.0.0.0' || configuredHost === '::'
    ? '127.0.0.1'
    : configuredHost
  const host = localHost.includes(':') && !localHost.startsWith('[') ? `[${localHost}]` : localHost
  return `http://${host}:${config.proxyPort}`
}

export function createProxyHeaders(config: Pick<AppConfig, 'enableApiKey' | 'apiKeys' | 'internalProxyKey'>): HeadersInit {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (config.internalProxyKey) headers.Authorization = `Bearer ${config.internalProxyKey}`
  else if (config.enableApiKey) {
    const apiKey = config.apiKeys.find(item => item.enabled)
    if (!apiKey) throw new Error('API key authentication is enabled, but no enabled API key is configured.')
    headers.Authorization = `Bearer ${apiKey.key}`
  }
  return headers
}

/** Deadline for response headers; active generation uses the proxy's idle deadline. */
export async function fetchWithHeaderTimeout(url: string, init: RequestInit, timeout: number, fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), timeout)
  try { return await fetcher(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal }) }
  finally { clearTimeout(timer) }
}

export async function readChatCompletionStream(
  response: Response,
  onDelta: (delta: ChatStreamDelta) => void,
  onActivity?: () => void,
): Promise<void> {
  if (!response.ok) {
    const body = await response.text()
    try {
      const parsed = JSON.parse(body) as { error?: string | { message?: string } }
      const detail = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message
      throw new Error(detail ? `HTTP ${response.status}: ${detail}` : `HTTP ${response.status}`)
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(body || `HTTP ${response.status}`)
      throw error
    }
  }

  if (!response.body) throw new Error('The server returned an empty response stream')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let scanFrom = 0
  let dataLines: string[] = []
  let eventLength = 0
  let finished = false
  let finishReasonReceived = false
  const maxEventLength = 4 * 1024 * 1024

  const dispatch = () => {
    if (finished || !dataLines.length) return
    const data = dataLines.join('\n').trim()
    dataLines = []
    eventLength = 0
    if (!data) return
    if (data === '[DONE]') { finished = true; return }

    const chunk = JSON.parse(data) as ChatCompletionChunk
    if (chunk.error) throw new Error(typeof chunk.error === 'string' ? chunk.error : chunk.error.message || 'Upstream stream failed')
    const reason = chunk.choices?.[0]?.finish_reason
    if (reason) finishReasonReceived = true
    const delta = chunk.choices?.[0]?.delta
    const toolCalls = (delta?.tool_calls || []).map(call => call?.function?.name).filter((name): name is string => typeof name === 'string' && !!name)
    if (delta?.content || delta?.reasoning_content || toolCalls.length) {
      onDelta({
        ...(delta?.content ? { content: delta.content } : {}),
        ...(delta?.reasoning_content ? { reasoning: delta.reasoning_content } : {}),
        ...(toolCalls.length ? { toolCalls } : {}),
      })
    }
    if (reason === 'length') throw new Error('模型已达到输出或上下文上限，当前回复尚未完整。请继续生成、分段处理，或选择更大上下文的模型。 / The model reached its output or context limit; this reply is incomplete. Continue, split the input, or choose a larger-context model.')
  }

  const consumeLine = (line: string) => {
    if (line.length > maxEventLength) throw new Error('SSE line exceeds the 4 MiB limit')
    if (!line) { dispatch(); return }
    if (line === 'data' || line.startsWith('data:')) {
      eventLength += line.length + 1
      if (eventLength > maxEventLength) throw new Error('SSE event exceeds the 4 MiB limit')
      dataLines.push(line.slice(5).replace(/^ /, ''))
    }
  }

  const consume = (text: string, final: boolean) => {
    buffer += text
    let start = 0
    let index = scanFrom
    for (; index < buffer.length; index++) {
      const char = buffer[index]
      if (char !== '\r' && char !== '\n') continue
      if (char === '\r' && index === buffer.length - 1 && !final) break
      consumeLine(buffer.slice(start, index))
      if (finished) { buffer = ''; return }
      if (char === '\r' && buffer[index + 1] === '\n') index++
      start = index + 1
    }
    scanFrom = index - start
    buffer = buffer.slice(start)
    if (buffer.length > maxEventLength) throw new Error('SSE line exceeds the 4 MiB limit')
    if (final) {
      if (buffer) consumeLine(buffer)
      dispatch()
    }
  }

  try {
    while (!finished) {
      const { done, value } = await reader.read()
      if (value?.length) onActivity?.()
      consume(decoder.decode(value, { stream: !done }), done)
      if (done) {
        if (!finished && !finishReasonReceived) throw new Error('The response stream ended before completion. Please retry.')
        break
      }
    }
  } finally {
    try { await reader.cancel() } finally { reader.releaseLock() }
  }
}
