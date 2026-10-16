/** Model requests stay inside Electron; only the main process contacts providers. */
export async function internalInferenceFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const signal = init.signal
  signal?.throwIfAborted()
  if (path !== '/v1/models' && path !== '/v1/models/verify' && path !== '/v1/chat/completions') throw new Error('Unknown internal model operation')
  const method = (init.method || 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'POST') throw new Error('Unsupported internal model request method')
  const api = window.electronAPI.inference
  if (!api) throw new Error('The internal model service is unavailable. Restart the desktop application.')
  if (init.body != null && typeof init.body !== 'string') throw new Error('Internal model requests require a JSON body')
  const body = init.body == null ? undefined : JSON.parse(init.body as string)

  const id = crypto.randomUUID()
  const encoder = new TextEncoder()
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let finished = false
  let dispatched = false
  let cancellationSent = false
  let unsubscribe = () => {}
  let rejectAbort!: (reason: unknown) => void
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  const cleanup = () => { unsubscribe(); signal?.removeEventListener('abort', onAbort) }
  const cancel = () => {
    if (dispatched && !cancellationSent) {
      cancellationSent = true
      void api.cancel(id).catch(error => console.error('[Internal inference] Could not cancel request:', error))
    }
  }
  const end = (error?: unknown) => {
    if (finished) return
    finished = true
    cleanup()
    if (error) controller.error(error)
    else controller.close()
  }
  const onAbort = () => {
    const reason = signal?.reason || new DOMException('Request cancelled', 'AbortError')
    end(reason)
    cancel()
    rejectAbort(reason)
  }
  const stream = new ReadableStream<Uint8Array>({
    start(value) { controller = value },
    cancel() { if (!finished) { finished = true; cleanup(); cancel() } },
  })
  // Subscribe first: a fast local model may send its first chunk before invoke resolves.
  unsubscribe = api.onData(event => {
    if (event.id !== id || finished) return
    if (event.data) controller.enqueue(encoder.encode(event.data))
    if (event.error) end(new Error(event.error))
    else if (event.done) end()
  })
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    signal?.throwIfAborted()
    dispatched = true
    const result = await Promise.race([api.request({
      id, path, method,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      ...(body !== undefined ? { body } : {}),
    }), aborted])
    signal?.throwIfAborted()
    if (result.stream) return new Response(stream, { status: result.status, headers: result.headers })
    end()
    return new Response(result.body === undefined ? null : typeof result.body === 'string' ? result.body : JSON.stringify(result.body), {
      status: result.status, headers: result.headers,
    })
  } catch (error) {
    end(error)
    cancel()
    throw error
  }
}
