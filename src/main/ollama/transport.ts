import { validateHeaderName, validateHeaderValue } from 'node:http'
import type { OllamaAuthInput, OllamaEndpoint } from '../../shared/types'

export function isOllamaResponse(data: any, endpoint: OllamaEndpoint, requireContent = false): boolean {
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.error) return false
  const text = (value: unknown) => typeof value === 'string' && (!requireContent || value.trim().length > 0)
  const calls = (value: any) => Array.isArray(value) && value.length > 0
    && value.every(call => typeof call?.function?.name === 'string' && call.function.name.length > 0)
  if (endpoint === 'ollama_chat') return text(data.message?.content) || text(data.message?.thinking) || calls(data.message?.tool_calls)
  if (endpoint === 'ollama_generate') return text(data.response) || text(data.thinking)
  if (endpoint === 'openai_chat') {
    return Array.isArray(data.choices) && data.choices.length > 0 && data.choices.every((choice: any) => {
      const message = choice?.message
      return text(message?.content) || text(message?.reasoning_content) || text(message?.refusal)
        || calls(message?.tool_calls)
        || (text(message?.function_call?.name) && typeof message?.function_call?.arguments === 'string')
        || (!requireContent && choice?.finish_reason === 'content_filter' && message?.content === null)
    })
  }
  if (endpoint === 'openai_completion') return text(data.choices?.[0]?.text)
  return Array.isArray(data.content) && data.content.some((block: any) =>
    (block?.type === 'text' && text(block.text)) || (block?.type === 'thinking' && text(block.thinking))
    || (block?.type === 'tool_use' && typeof block.name === 'string' && block.name.length > 0))
}

/** Shared by discovery and forwarding so saved authentication has identical semantics. */
export function buildOllamaHeaders(
  account?: { credentials: Record<string, string> },
  extraHeaders: Record<string, string> = {},
): Record<string, string> {
  const credentials = account?.credentials || {}
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
    ...Object.fromEntries(Object.entries(extraHeaders).map(([key, value]) => [key.toLowerCase(), value])),
  }
  if (credentials.authType === 'basic' && credentials.username) {
    headers.authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password || ''}`).toString('base64')}`
  } else if (credentials.authType === 'bearer' && credentials.token) {
    headers.authorization = `Bearer ${credentials.token}`
  } else if (credentials.authType === 'api-key' && credentials.headerName) {
    headers[credentials.headerName.toLowerCase()] = credentials.headerValue || ''
  }
  for (const [name, value] of Object.entries(headers)) {
    validateHeaderName(name)
    validateHeaderValue(name, value)
  }
  return headers
}

export function mergeOllamaAuth(auth: OllamaAuthInput, previous: Record<string, string>): Record<string, string> {
  if (!auth || !['none', 'basic', 'bearer', 'api-key'].includes(auth.type)) throw new Error('Invalid authentication type')
  const fields = auth.type === 'basic' ? ['username', 'password'] as const
    : auth.type === 'bearer' ? ['token'] as const
      : auth.type === 'api-key' ? ['headerName', 'headerValue'] as const : []
  const credentials: Record<string, string> = { authType: auth.type }
  for (const field of fields) {
    const value = auth[field] ?? (previous.authType === auth.type ? previous[field] : '') ?? ''
    if (typeof value !== 'string') throw new Error(`${field} must be text`)
    credentials[field] = value
  }
  if (auth.type === 'basic' && (!credentials.username || credentials.username.includes(':'))) {
    throw new Error('Basic authentication requires a username without a colon')
  }
  if (auth.type === 'bearer' && !credentials.token.trim()) throw new Error('A bearer token is required')
  if (auth.type === 'api-key') {
    if (!credentials.headerName || !credentials.headerValue) throw new Error('API key header name and value are required')
    if (/^(host|content-length|connection|transfer-encoding|content-type)$/i.test(credentials.headerName)) {
      throw new Error('This header is reserved for HTTP transport')
    }
  }
  buildOllamaHeaders({ credentials })
  return credentials
}
