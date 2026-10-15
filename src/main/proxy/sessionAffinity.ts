/** OpenCode's native session header is a routing hint, never an authorization grant. */
export function openCodeAffinityKey(headers: Record<string, unknown>, model: string): string | undefined {
  const session = headers['x-opencode-session-id']
  if (typeof session !== 'string' || !/^ses_[A-Za-z0-9_-]{1,160}$/.test(session)) return undefined
  return JSON.stringify([session, model])
}

export class SessionAffinity {
  private entries: ReadonlyMap<string, { accountId: string; expiresAt: number }> = new Map()
  private readonly limit: number
  private readonly ttl: number
  private readonly now: () => number
  constructor(limit = 1024, ttl = 30 * 60 * 1000, now = Date.now) {
    this.limit = limit; this.ttl = ttl; this.now = now
  }

  get(key: string | undefined): string | undefined {
    if (!key) return undefined
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= this.now()) { this.forget(key, entry.accountId); return undefined }
    return entry.accountId
  }

  remember(key: string | undefined, accountId: string): void {
    if (!key) return
    this.entries = new Map([
      ...[...this.entries].filter(([existing]) => existing !== key),
      [key, { accountId, expiresAt: this.now() + this.ttl }] as const,
    ].slice(-this.limit))
  }

  forget(key: string | undefined, accountId: string): void {
    if (key && this.entries.get(key)?.accountId === accountId) {
      this.entries = new Map([...this.entries].filter(([existing]) => existing !== key))
    }
  }
}

export const openCodeSessionAffinity = new SessionAffinity()
