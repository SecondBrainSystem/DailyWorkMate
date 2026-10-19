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

/** Loopback hosts and socket addresses, including IPv4-mapped IPv6 (::ffff:127.0.0.1) and ::1. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (typeof address !== 'string') return false
  const host = address.trim().toLowerCase().replace(/^\[([^\]]+)\]$/, '$1').replace(/^::ffff:/, '')
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host)
}

interface ExposureConfig {
  proxyHost?: string
  additionalProxyListeners?: readonly ProxyListenerConfig[]
  enableApiKey?: boolean
  apiKeys?: readonly { key?: string; enabled?: boolean }[]
}

export function hasUsableApiKey(config: ExposureConfig): boolean {
  return Boolean(config.enableApiKey) && (config.apiKeys || []).some(key => key?.enabled && typeof key.key === 'string' && key.key.trim())
}

/** A configured listener reachable from other machines must require an API key. */
export function networkExposureError(config: ExposureConfig): string | undefined {
  const hosts = [config.proxyHost, ...(Array.isArray(config.additionalProxyListeners) ? config.additionalProxyListeners.map(listener => listener?.host) : [])]
    .filter((host): host is string => typeof host === 'string' && Boolean(host.trim()))
  const exposed = hosts.filter(host => !isLoopbackAddress(host))
  if (!exposed.length || hasUsableApiKey(config)) return undefined
  return `A proxy service listens on ${exposed.join(', ')}, which other devices can reach. Keep API key authentication enabled with at least one enabled key, or change those services to 127.0.0.1 first. / 代理服务监听 ${exposed.join(', ')}，局域网设备可以访问。请保持 API Key 认证开启并至少保留一个启用的 Key，或先把这些服务改为 127.0.0.1。`
}
