import { Agent as HttpAgent } from 'node:http'
import { Agent as HttpsAgent } from 'node:https'
import type { Duplex } from 'node:stream'

// Only bound connection establishment. Long prompt evaluation and active generation
// retain the upstream request timeout, independently of this deadline.
export function limitConnection<T extends Duplex | null | undefined>(socket: T, event: 'connect' | 'secureConnect', timeout: number): T {
  if (!socket) return socket
  const clear = () => {
    clearTimeout(timer)
    socket.removeListener(event, clear)
    socket.removeListener('close', clear)
    socket.removeListener('error', clear)
  }
  const timer = setTimeout(() => {
    clear()
    socket.destroy(Object.assign(new Error(`Node connection timed out after ${timeout}ms`), { code: 'ETIMEDOUT', syscall: 'connect' }))
  }, timeout)
  timer.unref()
  socket.once(event, clear)
  socket.once('close', clear)
  socket.once('error', clear)
  return socket
}

class BoundedHttpAgent extends HttpAgent {
  private readonly connectionTimeout: number

  constructor(timeout: number) {
    super()
    this.connectionTimeout = timeout
  }

  override createConnection(...args: Parameters<HttpAgent['createConnection']>) {
    return limitConnection(super.createConnection(...args), 'connect', this.connectionTimeout)
  }
}

class BoundedHttpsAgent extends HttpsAgent {
  private readonly connectionTimeout: number

  constructor(timeout: number) {
    super()
    this.connectionTimeout = timeout
  }

  override createConnection(...args: Parameters<HttpsAgent['createConnection']>) {
    return limitConnection(super.createConnection(...args), 'secureConnect', this.connectionTimeout)
  }
}

// Use the caller's timeout for discovery, model tests and chats alike. A hidden
// shorter connection deadline made chats fail even when a model test could pass.
// Agents do not keep idle sockets, so per-request instances need no pool cleanup.
export function createOllamaAgents(timeout: number) {
  return {
    httpAgent: new BoundedHttpAgent(timeout),
    httpsAgent: new BoundedHttpsAgent(timeout),
  }
}
