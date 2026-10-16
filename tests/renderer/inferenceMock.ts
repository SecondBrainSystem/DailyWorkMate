/** Adapts in-memory Responses to the IPC contract; never opens an HTTP listener. */
export function installInferenceMock(respond: (path: string, init: RequestInit) => Promise<Response>): () => void {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const listeners = new Set<(event: { id: string; data?: string; done?: boolean; error?: string }) => void>()
  const controllers = new Map<string, AbortController>()
  const emit = (event: { id: string; data?: string; done?: boolean; error?: string }) => { for (const listener of [...listeners]) listener(event) }
  const inference = {
    onData(listener: typeof listeners extends Set<infer T> ? T : never) { listeners.add(listener); return () => { listeners.delete(listener) } },
    async cancel(id: string) { controllers.get(id)?.abort(); controllers.delete(id) },
    async request(input: { id: string; path: string; method: string; body?: unknown; headers: Record<string, string> }) {
      const controller = new AbortController()
      controllers.set(input.id, controller)
      const response = await respond(input.path, { method: input.method, headers: input.headers, body: input.body === undefined ? undefined : JSON.stringify(input.body), signal: controller.signal })
      if (controller.signal.aborted) throw controller.signal.reason
      if (!response.body) { controllers.delete(input.id); return { status: response.status, headers: Object.fromEntries(response.headers), body: null } }
      const reader = response.body.getReader()
      controller.signal.addEventListener('abort', () => { void reader.cancel() }, { once: true })
      void (async () => {
        const decoder = new TextDecoder()
        try {
          while (!controller.signal.aborted) {
            const { done, value } = await reader.read()
            emit({ id: input.id, data: decoder.decode(value, { stream: !done }), ...(done ? { done: true } : {}) })
            if (done) break
          }
        } catch (error) { emit({ id: input.id, error: String(error) }) }
        finally { reader.releaseLock(); controllers.delete(input.id) }
      })()
      return { status: response.status, headers: Object.fromEntries(response.headers), stream: true }
    },
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: { inference } } })
  return () => {
    for (const controller of controllers.values()) controller.abort()
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
}
