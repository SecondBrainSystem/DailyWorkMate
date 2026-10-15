/** Credentials are stored as strings; older imports may contain a cookie map. */
export function parseStoredCookies(value: unknown): Record<string, string> {
  if (!value) return {}
  let parsed = value
  if (typeof value === 'string') {
    if (value.trim().startsWith('{')) {
      try { parsed = JSON.parse(value) } catch { throw new Error('Invalid saved cookie JSON') }
    } else {
      parsed = Object.fromEntries(value.split(';').map(part => part.trim()).filter(Boolean).map(part => {
        const separator = part.indexOf('=')
        if (separator < 1) throw new Error('Invalid saved cookie header')
        return [part.slice(0, separator), part.slice(separator + 1)]
      }))
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.entries(parsed).some(([key, value]) => !key || typeof value !== 'string' || /[\r\n;]/.test(key + value))) {
    throw new Error('Saved cookies must contain cookie names and text values')
  }
  return { ...parsed } as Record<string, string>
}
