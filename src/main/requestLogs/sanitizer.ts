import type { RequestLogEntry } from '../store/types.ts'
import type { RequestLogConfig } from './types.ts'
import { redactSecrets } from '../../shared/redaction.ts'

export function sanitizeRequestLogEntry(
  entry: Omit<RequestLogEntry, 'id'>,
  config: RequestLogConfig,
): Omit<RequestLogEntry, 'id'> {
  const text = (value: string | undefined, limit: number) => truncateText(
    value && config.redactSensitiveData ? String(redactSecrets(value)) : value, limit,
  )
  return {
    ...entry,
    userInput: text(entry.userInput, 500),
    errorStack: text(entry.errorStack, 4000),
    responsePreview: text(entry.responsePreview, 1000),
    errorMessage: text(entry.errorMessage, 1000),
    requestBody: config.includeBodies ? sanitizeRequestLogBody(entry.requestBody, config) : undefined,
    responseBody: config.includeBodies ? sanitizeRequestLogBody(entry.responseBody, config) : undefined,
  }
}

export function sanitizeRequestLogUpdates(
  updates: Partial<RequestLogEntry>,
  config: RequestLogConfig,
): Partial<RequestLogEntry> {
  // A partial update must never create absent fields and erase the initial request.
  const sanitized = sanitizeRequestLogEntry(updates as Omit<RequestLogEntry, 'id'>, config)
  return Object.fromEntries(Object.keys(updates)
    .filter(key => updates[key as keyof RequestLogEntry] !== undefined)
    .map(key => [key, sanitized[key as keyof typeof sanitized]]))
}

export function trimRequestLogsToMaxEntries(
  entries: RequestLogEntry[],
  config: RequestLogConfig,
): RequestLogEntry[] {
  const maxEntries = Math.max(0, config.maxEntries)
  if (maxEntries === 0) {
    return []
  }

  if (entries.length <= maxEntries) {
    return entries
  }

  return entries.slice(entries.length - maxEntries)
}

function sanitizeRequestLogBody(value: string | undefined, config: RequestLogConfig): string | undefined {
  if (!value) return value

  const redacted = config.redactSensitiveData ? redactSensitiveText(value) : value
  return truncateText(redacted, config.maxBodyChars)
}

function truncateText(value: string | undefined, maxChars: number): string | undefined {
  if (!value) return value
  if (maxChars <= 0) return undefined
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}...[truncated ${value.length - maxChars} chars]`
}

function redactSensitiveText(value: string): string {
  try { return JSON.stringify(redactSecrets(JSON.parse(value))) }
  catch { return String(redactSecrets(value)) }
}
