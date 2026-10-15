import { randomBytes, timingSafeEqual } from 'node:crypto'
// Ephemeral, never persisted or exported. Available only through the isolated desktop bridge.
export const internalProxyKey = randomBytes(32).toString('hex')
export function isInternalProxyKey(key: unknown): boolean {
  return typeof key === 'string' && /^[a-f0-9]{64}$/.test(key) && timingSafeEqual(Buffer.from(key), Buffer.from(internalProxyKey))
}
