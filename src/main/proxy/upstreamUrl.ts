/**
 * Join a provider base URL and a chat path. Shared by the proxy forwarder and direct client
 * connections so both always reach the same upstream URL.
 *
 * When the base already ends in an API version segment (/v1, /v1beta, /v2 ...), a leading /v1
 * in the path is dropped: `https://host/v1` + `/v1/chat/completions` -> `https://host/v1/chat/completions`.
 */
export function buildUpstreamUrl(apiEndpoint: string, chatPath: string): string {
  const base = apiEndpoint.trim().replace(/\/+$/, '')
  const path = chatPath.startsWith('/') ? chatPath : `/${chatPath}`
  const versioned = /\/v\d+[a-z0-9]*$/i.test(base)
  return `${base}${versioned && /^\/v1(?:\/|$)/.test(path) ? path.slice(3) : path}`
}
