import type { Server as HttpServer } from 'http'
import type { Socket } from 'net'

export const SERVER_SHUTDOWN_GRACE_MS = 1000

/**
 * Stop accepting requests and give active requests a short grace period before
 * destroying connections that would otherwise keep server.close() pending.
 */
export function closeHttpServer(
  server: HttpServer,
  connections: ReadonlySet<Socket>,
  graceMs = SERVER_SHUTDOWN_GRACE_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(forceCloseTimer)
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }

    const forceCloseTimer = setTimeout(() => {
      server.closeAllConnections()
      for (const connection of connections) {
        connection.destroy()
      }
    }, Math.max(0, graceMs))
    forceCloseTimer.unref()

    server.close(error => finish(error || undefined))
    server.closeIdleConnections()
  })
}
