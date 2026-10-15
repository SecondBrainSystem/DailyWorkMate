import { PassThrough, Transform, pipeline, type Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import type { IncomingMessage, ServerResponse } from 'node:http'

const MAX_LOG_CHARS = 1024 * 1024

/** Reset the deadline for every chunk and cancel the upstream on close. */
export function watchResponseStream(source: Readable, timeout: number, signal?: AbortSignal): Readable {
  const output = new PassThrough()
  output.on('error', () => {}) // Preserve an early error until the consumer attaches.
  let timer: NodeJS.Timeout | undefined
  const reset = () => {
    clearTimeout(timer)
    timer = setTimeout(() => output.destroy(new Error('Upstream stream timed out while waiting for output')), Math.max(1000, timeout))
    timer.unref()
  }
  const abort = () => output.destroy(new Error('Client cancelled the request'))
  const cleanup = () => { clearTimeout(timer); source.off('data', reset); signal?.removeEventListener('abort', abort) }
  source.on('data', reset)
  source.once('error', error => output.destroy(error))
  source.once('close', () => { if (!source.readableEnded && !output.destroyed) output.destroy(new Error('Upstream closed before completion')) })
  output.once('close', () => { cleanup(); source.destroy() })
  output.once('end', cleanup)
  signal?.addEventListener('abort', abort, { once: true })
  reset()
  source.pipe(output)
  // First-output prefetch may finish just before its stream fails. That error
  // can already have fired while the forwarder was awaiting the result.
  if (source.errored) output.destroy(source.errored)
  else if (source.destroyed && !source.readableEnded) output.destroy(new Error('Upstream closed before completion'))
  if (signal?.aborted) abort()
  return output
}

export function convertUpstreamStream(source: Readable, transform: Transform): Transform {
  source.once('error', error => { if (!transform.readableEnded) transform.destroy(error) })
  source.once('close', () => {
    if (!source.readableEnded && !transform.readableEnded && !transform.destroyed) transform.destroy(new Error('Upstream connection closed before the response ended'))
  })
  transform.once('end', () => {
    source.unpipe(transform)
    if (!transform.writableEnded) transform.end()
    source.destroy()
  })
  transform.once('close', () => source.destroy())
  return source.pipe(transform)
}

/** Cancel model loading before headers as well as active generation. */
export function clientAbortSignal(ctx: { req: IncomingMessage; res: ServerResponse }): AbortSignal {
  const controller = new AbortController()
  const abort = () => controller.abort()
  const close = () => {
    if (!ctx.res.writableFinished) abort()
    cleanup()
  }
  const cleanup = () => {
    ctx.req.off('aborted', abort)
    ctx.res.off('close', close)
    ctx.res.off('finish', cleanup)
  }
  ctx.req.once('aborted', abort)
  ctx.res.once('close', close)
  ctx.res.once('finish', cleanup)
  if (ctx.req.aborted || ctx.res.destroyed) abort()
  return controller.signal
}

/** Bounded logging, backpressure, error framing and cleanup share one lifecycle. */
export function relayResponseStream(
  source: NodeJS.ReadableStream,
  transforms: Transform[],
  protocol: 'openai' | 'ollama' | 'claude',
  onComplete: (error: Error | undefined, body: string) => void,
): PassThrough {
  const output = new PassThrough()
  const decoder = new StringDecoder('utf8')
  let tail = ''
  let pending = ''
  let upstreamError: Error | undefined
  let settled = false
  const inspect = (text: string) => {
    tail = (tail + text).slice(-MAX_LOG_CHARS)
    pending += text
    const lines = pending.split(/\r?\n/)
    pending = (lines.pop() || '').slice(-MAX_LOG_CHARS)
    for (const line of lines) {
      const raw = line.startsWith('data:') ? line.slice(5).trim() : line.trim()
      if (!raw.startsWith('{')) continue
      try {
        const event = JSON.parse(raw)
        if (event.error) upstreamError = new Error(typeof event.error === 'string' ? event.error : event.error.message || 'Upstream stream failed')
      } catch {
        // Protocol transforms validate JSON. This observer only reads logs and error events.
      }
    }
  }
  const observer = new Transform({
    transform(chunk, _encoding, callback) {
      inspect(decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
      callback(null, chunk)
    },
    flush(callback) { inspect(decoder.end() + '\n'); callback() },
  })
  const complete = (error?: Error) => {
    if (settled) return
    settled = true
    onComplete(error || upstreamError, tail)
  }
  const streams = [source as Readable, ...transforms, observer]
  // Keep the client-facing stream writable when the internal pipeline fails.
  observer.pipe(output, { end: false })
  pipeline(streams, error => {
    if (settled) return
    if (error && !output.destroyed && !output.writableEnded) {
      const detail = { type: 'api_error', message: error.message }
      const frame = protocol === 'ollama' ? `${JSON.stringify({ error: error.message })}\n`
        : protocol === 'claude' ? `event: error\ndata: ${JSON.stringify({ type: 'error', error: detail })}\n\n`
          : `data: ${JSON.stringify({ error: detail })}\n\ndata: [DONE]\n\n`
      output.write(frame)
    }
    complete(error || undefined)
    output.end()
  })
  output.once('close', () => {
    if (!settled) complete(new Error('Client disconnected before the response completed'))
    for (const stream of streams) stream.destroy()
  })
  return output
}
