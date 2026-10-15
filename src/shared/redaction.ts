const sensitive = /authorization|cookie|password|secret|credentials|api[_-]?key|(?:access|refresh|session|service|ph)?[_-]?token|ticket|^key$/i
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[truncated]'
  if (typeof value === 'string') return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/(["']?(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|cookie|password|managementApiSecret)["']?\s*[:=]\s*)["']?[^"',}\r\n]+/gi, '$1[REDACTED]')
  if (Array.isArray(value)) return value.map(item => redactSecrets(item, depth + 1))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sensitive.test(key) ? '[REDACTED]' : redactSecrets(item, depth + 1)]))
  return value
}
