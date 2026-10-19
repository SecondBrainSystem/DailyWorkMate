import { isLoopbackAddress } from '../../shared/proxyListeners.ts'
import type { ApiKey } from '../store/types.ts'

export type ApiKeyAuthResult =
  | { ok: true; keyId?: string }
  | { ok: false; code: 'missing_api_key' | 'invalid_api_key'; message: string }

export interface ApiKeyAuthInput {
  enableApiKey: boolean
  apiKeys?: readonly Pick<ApiKey, 'id' | 'key' | 'enabled'>[]
  providedKey?: string
  /** Socket addresses of the request; absent addresses are treated as remote. */
  localAddress?: string
  remoteAddress?: string
}

/**
 * Decide API key authentication for one request. A request that arrives on or from a
 * non-loopback address always needs a valid key, even when key checking is turned off,
 * so changing settings while a LAN listener is running can never expose it.
 */
export function authorizeApiKey(input: ApiKeyAuthInput): ApiKeyAuthResult {
  const fromNetwork = !isLoopbackAddress(input.localAddress) || !isLoopbackAddress(input.remoteAddress)
  if (!input.enableApiKey && !fromNetwork) return { ok: true }
  if (!input.providedKey) {
    return { ok: false, code: 'missing_api_key', message: input.enableApiKey ? 'API key is required' : 'API key is required for requests from other devices' }
  }
  const valid = (input.apiKeys || []).find(key => key.enabled && typeof key.key === 'string' && key.key && key.key === input.providedKey)
  return valid ? { ok: true, keyId: valid.id } : { ok: false, code: 'invalid_api_key', message: 'Invalid API key' }
}
