export interface ListenerEndpoint {
  port: number
  host: string
}

interface ListenerStatus extends ListenerEndpoint {
  isRunning: boolean
}

interface ProxyListenerStatus extends ListenerStatus {
  listeners?: ListenerStatus[]
}

export function normalizeListenerHost(host: string): string {
  return host.trim().replace(/^\[([^\]]*:[^\]]*)\]$/, '$1').toLowerCase()
}

export function listenerKey(endpoint: ListenerEndpoint): string {
  return `${normalizeListenerHost(endpoint.host)}:${endpoint.port}`
}

/** host:port as typed in a client; IPv6 hosts need brackets or the port is read as part of the address. */
export function listenerAddress(endpoint: ListenerEndpoint): string {
  const host = normalizeListenerHost(endpoint.host)
  return `${host.includes(':') ? `[${host}]` : host}:${endpoint.port}`
}

export function listenerUrl(endpoint: ListenerEndpoint): string {
  return `http://${listenerAddress(endpoint)}/v1`
}

export function validateListenerPort(value: string): string | undefined {
  if (!/^\d+$/.test(value) || !Number.isInteger(Number(value))) return 'proxy.portMustBeInteger'
  if (Number(value) < 1 || Number(value) > 65535) return 'proxy.portRangeError'
  return undefined
}

export function validateListenerHost(value: string): string | undefined {
  const host = normalizeListenerHost(value)
  if (!host) return 'proxy.bindAddressEmpty'
  if (host.includes(':')) {
    try {
      new URL(`http://[${host}]/`)
      return undefined
    } catch {
      return 'proxy.invalidIpOrHostname'
    }
  }
  if (/^[\d.]+$/.test(host)) {
    return /^(\d{1,3}\.){3}\d{1,3}$/.test(host) && host.split('.').every(part => Number(part) <= 255)
      ? undefined : 'proxy.invalidIpOrHostname'
  }
  const valid = host.length <= 253 && host.split('.').every(label => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))
  return valid ? undefined : 'proxy.invalidIpOrHostname'
}

export function getProxyListeners(
  primary: ListenerEndpoint,
  additional: ListenerEndpoint[],
  status: ProxyListenerStatus | null,
) {
  // Older app versions expose only one active endpoint. An explicit empty list
  // in the new status means that every listener is stopped.
  const active = status?.listeners ?? (status?.isRunning ? [status] : [])
  const candidates = [primary, ...additional, ...active.filter(listener => listener.isRunning)]
  return candidates
    .filter((endpoint, index) => candidates.findIndex(other => listenerKey(other) === listenerKey(endpoint)) === index)
    .map(endpoint => ({
      port: endpoint.port,
      host: normalizeListenerHost(endpoint.host),
      primary: listenerKey(endpoint) === listenerKey(primary),
      saved: additional.some(other => listenerKey(other) === listenerKey(endpoint)),
      isRunning: active.some(other => listenerKey(other) === listenerKey(endpoint) && other.isRunning),
    }))
}
