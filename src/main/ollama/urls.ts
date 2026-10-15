export function normalizeOllamaUrl(value: string): string {
  if (typeof value !== 'string') throw new Error('URL must be text')
  const parsed = new URL(value.trim())
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only HTTP and HTTPS URLs are supported')
  }
  if (parsed.username || parsed.password) {
    throw new Error('Use the node authentication settings instead of credentials in the URL')
  }
  if (parsed.hostname.toLowerCase() === 'localhost') parsed.hostname = '127.0.0.1'
  parsed.hash = ''
  parsed.search = ''
  parsed.pathname = parsed.pathname.replace(/\/+$/, '')
  return parsed.toString().replace(/\/$/, '')
}

export function parseOllamaUrlList(text: string): { urls: string[]; invalid: string[] } {
  if (typeof text !== 'string') throw new Error('URL list must be text')
  const urls = new Set<string>()
  const invalid: string[] = []

  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith('//')) continue
    try {
      urls.add(normalizeOllamaUrl(line))
    } catch {
      invalid.push(line)
    }
  }

  return { urls: Array.from(urls), invalid }
}
