import { validateHeaderName, validateHeaderValue } from 'node:http'
import { buildOllamaHeaders } from '../ollama/transport'
import { normalizeOllamaUrl } from '../ollama/urls'
import type { AccountSelection } from '../proxy/types'
import type { ModelConnection, ModelConsumer } from '../../shared/modelConnection'

function connectionHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).flatMap(([name, value]) => {
    validateHeaderName(name)
    validateHeaderValue(name, value)
    // Streaming clients supply their own transport headers.
    if (/^(accept|content-type|content-length|host|connection|transfer-encoding)$/i.test(name)) return []
    return [[name.toLowerCase(), value]]
  }))
}

/** Return null only when an adapter is needed to speak the upstream's protocol. */
export function directModelConnection(selection: AccountSelection, consumer: ModelConsumer): ModelConnection | null {
  const { provider, account, actualModel } = selection
  if (provider.upstreamKind !== 'api' && provider.upstreamKind !== 'ollama') return null
  const endpoint = provider.ollamaModels?.[actualModel]?.endpoint
  const protocol = provider.upstreamKind === 'api' ? provider.apiProtocol
    : endpoint === 'openai_chat' ? 'openai' : endpoint === 'claude_chat' ? 'anthropic' : undefined
  if (!protocol || (consumer === 'claude' && protocol !== 'anthropic')) return null
  const base = normalizeOllamaUrl(provider.apiEndpoint)
  let baseURL = base
  if (provider.upstreamKind === 'ollama') baseURL = `${base}/v1`
  else {
    const expectedSuffix = protocol === 'anthropic' ? '/messages' : '/chat/completions'
    let chatPath = provider.chatPath || (protocol === 'anthropic' ? '/v1/messages' : '/chat/completions')
    if (!chatPath.startsWith('/')) chatPath = `/${chatPath}`
    if (base.endsWith('/v1') && chatPath.startsWith('/v1/')) chatPath = chatPath.slice(3)
    const target = `${base}${chatPath}`
    if (!target.endsWith(expectedSuffix)) return null
    baseURL = target.slice(0, -expectedSuffix.length)
    // Claude Code always adds /v1/messages itself.
    if (consumer === 'claude' && !baseURL.endsWith('/v1')) return null
  }
  const apiKey = provider.upstreamKind === 'api' ? account.credentials.apiKey : ''
  if (provider.upstreamKind === 'api' && !apiKey?.trim()) throw new Error(`Missing API key for ${provider.name}`)
  validateHeaderValue('authorization', apiKey || '')
  const headers = connectionHeaders(provider.upstreamKind === 'ollama'
    ? buildOllamaHeaders(account, provider.headers) : provider.headers)
  // Explicit saved auth wins over SDK defaults (including Basic and custom header auth).
  if (provider.upstreamKind === 'api') {
    const authHeader = protocol === 'anthropic' ? 'x-api-key' : 'authorization'
    return { baseURL, apiKey, model: actualModel, protocol, direct: true,
      headers: { ...headers, [authHeader]: protocol === 'anthropic' ? apiKey : `Bearer ${apiKey}` } }
  }
  return { baseURL, apiKey: 'dailyworkmate-direct', model: actualModel, protocol, headers, direct: true }
}
