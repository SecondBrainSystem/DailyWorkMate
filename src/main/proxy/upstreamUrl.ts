/**
 * Join a provider base URL and a chat path. Shared by the proxy forwarder and direct client
 * connections so both always reach the same upstream URL.
 *
 * When the base already carries an API version (ends in /v1, /v1beta, /v2 ..., or has a /v1 segment
 * anywhere, as gateways like `https://host/v1/openai` do), a leading /v1 in the path is dropped:
 * `https://host/v1` + `/v1/chat/completions` -> `https://host/v1/chat/completions`.
 */
export function buildUpstreamUrl(apiEndpoint: string, chatPath: string): string {
  const base = apiEndpoint.trim().replace(/\/+$/, '')
  const path = chatPath.startsWith('/') ? chatPath : `/${chatPath}`
  // The /v1-anywhere rule keeps existing custom providers on the URL they have always used.
  const versioned = /\/v\d+[a-z0-9]*$/i.test(base) || /\/v1[a-z0-9]*\//i.test(base)
  return `${base}${versioned && /^\/v1(?:\/|$)/.test(path) ? path.slice(3) : path}`
}
