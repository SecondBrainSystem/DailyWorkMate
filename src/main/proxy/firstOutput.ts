import { PassThrough, type Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'

/** stream_error: the response ended or broke; upstream_error: the node reported an error event. */
export type FirstOutputFailure = 'stream_error' | 'upstream_error' | 'timeout' | 'aborted'

export type FirstOutputResult =
  | { ok: true; stream: PassThrough }
  /** `finished`: the node completed normally but produced nothing (an empty answer), so it is reachable. */
  | { ok: false; reason: FirstOutputFailure; error: Error; finished?: boolean }

const MAX_PREFETCH_BYTES = 8 * 1024 * 1024
const ignore = () => {}

/**
 * True when an OpenAI-style SSE event carries something the client would show or act on.
 * A bare finish_reason is not output: nodes that answer with nothing are failed over (an
 * empty reply is never what the user asked for), but they are reported as `finished`.
 */
function isOutputEvent(payload: string): boolean | 'error' | 'finish' {
  if (payload === '[DONE]') return false
  let event: any
  try { event = JSON.parse(payload) } catch { return false }
  if (event?.error) return 'error'
  const choice = event?.choices?.[0]
  if (!choice) return false
  const delta = choice.delta || {}
  if (delta.content || delta.reasoning_content || delta.tool_calls?.length) return true
  return choice.finish_reason ? 'finish' : false
}

/**
 * Holds back a converted upstream stream until its first real output (text,
 * reasoning or a tool call), so a node that closes the response
 * before producing anything becomes an ordinary request failure that can be
 * retried or failed over, instead of an HTTP 200 the client sees break.
 * Everything received before that point is replayed unchanged.
 */
export function awaitFirstOutput(stream: Readable, timeoutMs: number, signal?: AbortSignal): Promise<FirstOutputResult> {
  return new Promise(resolve => {
    const decoder = new StringDecoder('utf8')
    const buffered: Buffer[] = []
    let bufferedBytes = 0
    let pending = ''
    let settled = false
    let finished = false

    const cleanup = () => {
      clearTimeout(timer)
      stream.off('data', onData)
      stream.off('error', onError)
      stream.off('end', onEnd)
      stream.off('close', onClose)
      signal?.removeEventListener('abort', onAbort)
    }
    const fail = (reason: FirstOutputFailure, error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      // Late errors from the abandoned attempt have no reader any more.
      stream.on('error', ignore)
      if (!stream.destroyed) stream.destroy()
      resolve({ ok: false, reason, error, ...(finished ? { finished } : {}) })
    }
    const ready = () => {
      if (settled) return
      settled = true
      // Pause before detaching the listener so no chunk is emitted with nobody reading it.
      stream.pause()
      cleanup()
      const output = new PassThrough()
      // The consumer attaches its pipeline a few ticks later; an error in between must not be
      // uncaught. pipeline() reads the errored state when it attaches, so nothing is lost.
      output.on('error', ignore)
      for (const chunk of buffered) output.write(chunk)
      stream.once('error', error => { if (!output.destroyed) output.destroy(error) })
      output.once('close', () => { if (!stream.destroyed) stream.destroy() })
      stream.pipe(output)
      resolve({ ok: true, stream: output })
    }
    const onData = (chunk: Buffer | string) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      buffered.push(data)
      bufferedBytes += data.length
      pending += decoder.write(data)
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() || ''
      for (const line of lines) {
        if (!line.startsWith('data:')) continue
        const verdict = isOutputEvent(line.slice(5).trim())
        if (verdict === 'error') {
          // An error reported before any output fails the request, so another node can be tried.
          let message = 'Upstream reported an error before producing output'
          try { const event = JSON.parse(line.slice(5).trim()); message = event.error?.message || event.error || message } catch { /* keep default */ }
          fail('upstream_error', new Error(String(message)))
          return
        }
        if (verdict === 'finish') { finished = true; continue }
        if (verdict) { ready(); return }
      }
      if (bufferedBytes > MAX_PREFETCH_BYTES) fail('stream_error', new Error('Upstream sent too much data without producing output'))
    }
    const onError = (error: Error) => fail('stream_error', error)
    const onEnd = () => fail('stream_error', new Error('Upstream stream ended before producing output'))
    const onClose = () => fail('stream_error', new Error('Upstream connection closed before producing output'))
    const onAbort = () => fail('aborted', new Error('Client cancelled the request'))
    const timer = setTimeout(
      () => fail('timeout', new Error(`No output from the node within ${Math.round(timeoutMs / 1000)}s`)),
      Math.max(1000, timeoutMs),
    )

    stream.on('data', onData)
    stream.once('error', onError)
    stream.once('end', onEnd)
    stream.once('close', onClose)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}
