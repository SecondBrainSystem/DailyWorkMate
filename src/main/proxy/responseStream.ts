import { PassThrough, Transform, finished, pipeline, type Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import type { IncomingMessage, ServerResponse } from 'node:http'

/** Longest partial line kept while looking for complete SSE/NDJSON events. */
const MAX_PENDING_LINE_CHARS = 1024 * 1024
/** Matches the request log default (requestLogs/types.ts maxBodyChars). */
const DEFAULT_LOG_BODY_CHARS = 8000
/** End of the stream kept for token counting when no usage line was recognised. */
const TAIL_CHARS = 4096
const USAGE_PATTERN = /"(?:usage|total_tokens|totalTokens|prompt_tokens|completion_tokens|input_tokens|output_tokens|prompt_eval_count|eval_count)"/

/**
 * Bounded record of a relayed stream for logs and token accounting: the first `maxBodyChars`
 * characters (what the request log keeps), the last line that carried token usage, and a short tail.
 * Memory and work per chunk stay constant however long the response runs.
 */
export function createStreamRecorder(maxBodyChars = DEFAULT_LOG_BODY_CHARS) {
  const limit = Math.max(0, Math.floor(maxBodyChars))
  let head = ''
  let total = 0
  let tail = ''
  let usageLine = ''
  return {
    append(text: string): void {
      total += text.length
      if (head.length < limit) head += text.slice(0, limit - head.length)
      tail += text
      // Trim only once the tail doubles, so each character is copied a bounded number of times.
      if (tail.length > TAIL_CHARS * 2) tail = tail.slice(-TAIL_CHARS)
    },
    line(line: string): void { if (USAGE_PATTERN.test(line)) usageLine = line },
    body(): string {
      if (total <= head.length) return head
      const recent = tail.slice(-TAIL_CHARS)
      const extra = [usageLine && !recent.includes(usageLine) ? usageLine : '', recent].filter(Boolean).join('\n')
      return head ? `${head}\n...[${total - head.length} chars not kept]\n${extra}` : extra
    },
  }
}

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

/**
 * Run provider session cleanup once the client-facing stream ends, fails or is closed early
 * (client disconnect). Replaces patching `stream.end`, which missed the last two cases.
 */
export function afterStream(stream: NodeJS.ReadableStream, label: string, cleanup: () => unknown): void {
  let ran = false
  finished(stream as Readable, () => {
    if (ran) return
    ran = true
    Promise.resolve().then(cleanup).catch(error => console.error(`[${label}] Failed to delete the upstream session:`, error))
  })
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
  options: { maxBodyChars?: number } = {},
): PassThrough {
  const output = new PassThrough()
  const decoder = new StringDecoder('utf8')
  const recorder = createStreamRecorder(options.maxBodyChars)
  let pending = ''
  let upstreamError: Error | undefined
  let settled = false
  const inspect = (text: string) => {
    recorder.append(text)
    pending += text
    const lines = pending.split(/\r?\n/)
    pending = (lines.pop() || '').slice(-MAX_PENDING_LINE_CHARS)
    for (const line of lines) {
      recorder.line(line)
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
    onComplete(error || upstreamError, recorder.body())
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
