import type { ProxyListenerConfig, ProxyStatus } from './types'

export function isProxyEndpointRunning(status: ProxyStatus | null, endpoint: ProxyListenerConfig): boolean {
  const hostKey = (host: string) => host.trim().replace(/^\[([^\]]+)\]$/, '$1').toLowerCase()
  const listeners = status?.listeners ?? (status?.isRunning ? [status] : [])
  return listeners.some(listener => listener.isRunning && listener.port === endpoint.port && hostKey(listener.host) === hostKey(endpoint.host))
}

function validHost(host: string): boolean {
  if (!host || host.length > 253) return false
  if (host.includes(':')) {
    try { new URL(`http://[${host}]/`); return true } catch { return false }
  }
  if (/^[\d.]+$/.test(host)) return /^(\d{1,3}\.){3}\d{1,3}$/.test(host) && host.split('.').every(part => Number(part) <= 255)
  return host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
}

/** Validate saved endpoints at the configuration boundary, without modifying input. */
export function parseProxyListeners(value: unknown): ProxyListenerConfig[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error('Specify at most 32 additional proxy services')
  const listeners = value.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid proxy service')
    const { port, host } = item as Record<string, unknown>
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Proxy port must be an integer between 1 and 65535')
    if (typeof host !== 'string') throw new Error('Invalid proxy host')
    const normalized = host.replace(/^\[([^\]]+)\]$/, '$1').toLowerCase()
    if (!validHost(normalized)) throw new Error('Invalid proxy host')
    return { port, host: normalized }
  })
  const keys = listeners.map(({ port, host }) => `${host}:${port}`)
  if (new Set(keys).size !== keys.length) throw new Error('Duplicate proxy services are not allowed')
  return listeners
}
