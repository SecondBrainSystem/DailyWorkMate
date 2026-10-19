import axios from 'axios'
import type { ForwardResult } from './types.ts'

/** The node could not be reached (refused, reset, DNS) before any HTTP response. */
export const UPSTREAM_UNREACHABLE = 'upstream_unreachable'
/** The node accepted the connection but produced nothing within the timeout. */
export const UPSTREAM_TIMEOUT = 'upstream_timeout'

const CONNECTION_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ERR_SOCKET_CLOSED'])
const TIMEOUT_ERROR_CODES = new Set(['ECONNABORTED', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'])

/** True for failures that say nothing about the request and everything about the node. */
export function isTransportFailure(result: Pick<ForwardResult, 'errorCode'>): boolean {
  return result.errorCode === UPSTREAM_UNREACHABLE || result.errorCode === UPSTREAM_TIMEOUT
}

/** Status and error code for a request that threw instead of returning an HTTP response. */
export function upstreamFailure(error: unknown, signal?: AbortSignal): Pick<ForwardResult, 'status' | 'errorCode' | 'error'> {
  const message = error instanceof Error ? error.message : String(error ?? 'Unknown error')
  if (signal?.aborted || axios.isCancel(error)) return { status: 499, errorCode: 'request_cancelled', error: message }
  const response = axios.isAxiosError(error) ? error.response : undefined
  if (response?.status) return { status: response.status, error: message, ...retryAfter(response.headers) }
  const code = String((error as { code?: unknown } | undefined)?.code || '')
  if (TIMEOUT_ERROR_CODES.has(code)) return { status: 504, errorCode: UPSTREAM_TIMEOUT, error: message }
  if (CONNECTION_ERROR_CODES.has(code) || (axios.isAxiosError(error) && !response)) return { status: 502, errorCode: UPSTREAM_UNREACHABLE, error: message }
  const status = Number((error as { status?: unknown } | undefined)?.status) || Number(message.match(/HTTP (\d{3})/)?.[1])
  return { status: status >= 400 && status < 600 ? status : 502, error: message }
}

/** Parse Retry-After (delta seconds or an HTTP date) into `{ retryAfterMs }`, or nothing. */
export function retryAfter(headers: unknown): Pick<ForwardResult, 'retryAfterMs'> {
  if (!headers || typeof headers !== 'object') return {}
  const record = headers as Record<string, unknown> & { get?: (name: string) => unknown }
  const raw = typeof record.get === 'function' ? record.get('retry-after') : record['retry-after'] ?? record['Retry-After']
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== 'string' && typeof value !== 'number') return {}
  const text = String(value).trim()
  if (/^\d+(?:\.\d+)?$/.test(text)) return { retryAfterMs: Math.round(Number(text) * 1000) }
  const date = Date.parse(text)
  return Number.isFinite(date) ? { retryAfterMs: Math.max(0, date - Date.now()) } : {}
}

/** Longest Retry-After honoured before retrying the same account; longer waits fail fast instead. */
export const MAX_RETRY_AFTER_MS = 10_000

/** Delay before repeating a request on the same account, or undefined when waiting is not worth it. */
export function sameAccountRetryDelay(result: Pick<ForwardResult, 'retryAfterMs'>, fallbackMs: number): number | undefined {
  if (result.retryAfterMs === undefined) return Math.max(0, fallbackMs)
  return result.retryAfterMs > MAX_RETRY_AFTER_MS ? undefined : Math.max(0, result.retryAfterMs)
}
