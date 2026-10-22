import { Readable } from 'node:stream'
import { createParser } from 'eventsource-parser'
import type { ChatCompletionRequest, ForwardResult } from '../proxy/types'
import { readBoundedJson, waitForKiloOperation } from './kiloModels'
import { redactSecrets } from '../../shared/redaction'

const MAX_EVENT = 4 * 1024 * 1024
class FreeTransportError extends Error {
  constructor(message: string, readonly status = 502) { super(message) }
}

function upstreamMessage(payload: any): string {
  const message = typeof payload?.error === 'string' ? payload.error : payload?.error?.message ?? payload?.message
  return typeof message === 'string' ? String(redactSecrets(message)).slice(0, 2000) : ''
}

const freeUsageLimited = (message: string) => /free usage (?:limit|exceeded)|rate.limit|quota.*(?:exceeded|reached)/i.test(message)

function upstreamError(label: string, detail: string, status: number): string {
  if (status !== 429 && !freeUsageLimited(detail)) return detail || `${label} request failed (HTTP ${status})`
  const hint = label === 'Kilo'
    ? 'Kilo 免费通道受上游限流，按公网 IP 计数，共享出口可能影响首次使用。 / Kilo free requests are rate limited by public IP, which may be shared.'
    : `${label} 免费通道触发上游使用限制，不代表你在本应用中已用完个人额度。 / ${label} free service is rate limited or has reached its upstream quota; this does not establish your personal usage in this app.`
  return `${hint}${detail ? `\n${detail}` : ''}`
}

function normalized(payload: any, model: string, label: string) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new FreeTransportError(`Invalid ${label} response`)
  if (payload.error) {
    const detail = upstreamMessage(payload)
    const upstreamStatus = Number(payload.error.status ?? payload.error.code)
    const status = Number.isInteger(upstreamStatus) && upstreamStatus >= 400 && upstreamStatus <= 599 ? upstreamStatus : freeUsageLimited(detail) ? 429 : 502
    throw new FreeTransportError(upstreamError(label, detail, status), status)
  }
  return { ...payload, object: 'chat.completion.chunk', model, choices: Array.isArray(payload.choices) ? payload.choices.map((choice: any) => {
    const delta = choice.delta ?? choice.message
    return { ...choice, ...(delta ? { delta: { ...delta,
      ...(choice.message?.tool_calls ? { tool_calls: choice.message.tool_calls.map((call: any, index: number) => ({ ...call, index })) } : {}),
      ...(typeof delta.reasoning_content === 'string' ? {} : typeof delta.reasoning === 'string' ? { reasoning_content: delta.reasoning } : {}),
    } } : {}) }
  }) : [] }
}

/** Inspect bytes instead of Content-Type: Kilo occasionally labels SSE as JSON. */
async function* packets(response: Response, model: string, activity: () => void, label: string): AsyncGenerator<any> {
  if (!response.body) throw new FreeTransportError(`Empty ${label} response`)
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let mode = '', head = '', finished = false, receivedFinish = false, receivedOutput = false, eventSize = 0
  let pending: string[] = []
  const parser = createParser({ onEvent: event => { pending.push(event.data); eventSize = 0 } })
  try {
    for (;;) {
      const next = await reader.read()
      if (next.value?.length) activity()
      const text = decoder.decode(next.value, { stream: !next.done })
      if (!mode) {
        head += text
        if (head.length > MAX_EVENT) throw new FreeTransportError(`${label} response exceeds 4 MiB`)
        if (!head.trim()) { if (next.done) break; continue }
        mode = head.trimStart().startsWith('{') ? 'json' : 'sse'
      }
      if (mode === 'json') {
        if (!next.done) {
          for (;;) {
            const row = await reader.read()
            if (row.value?.length) activity()
            head += decoder.decode(row.value, { stream: !row.done })
            if (head.length > MAX_EVENT) throw new FreeTransportError(`${label} JSON response exceeds 4 MiB`)
            if (row.done) break
          }
        }
        const packet = normalized(JSON.parse(head), model, label)
        if (!packet.choices.length) throw new FreeTransportError(`${label} returned no completion`)
        yield packet
        return
      }
      const incoming = head || text
      head = ''
      // Bound each frame, including a frame spanning many transport chunks.
      for (const part of incoming.split(/(?<=\n)/)) {
        eventSize += part.length
        if (eventSize > MAX_EVENT) throw new FreeTransportError(`${label} SSE event exceeds 4 MiB`)
        parser.feed(part)
      }
      const ready = pending
      pending = []
      for (const data of ready) {
        if (data === '[DONE]') { finished = true; break }
        const packet = normalized(JSON.parse(data), model, label)
        if (packet.choices.some((choice: any) => choice.finish_reason)) receivedFinish = true
        if (packet.choices.some((choice: any) => choice.delta?.content || choice.delta?.reasoning_content || choice.delta?.refusal || choice.delta?.tool_calls?.length)) receivedOutput = true
        yield packet
      }
      if (finished || next.done) break
    }
    if (!finished && !receivedFinish) throw new FreeTransportError(`${label} 响应在完成前中断，请重试。 / ${label} response ended before completion. Retry.`, 502)
    if (!receivedFinish && !receivedOutput) throw new FreeTransportError(`${label} 返回空回复，请重试。 / ${label} returned an empty completion. Retry.`, 502)
  } finally { try { await reader.cancel() } finally { reader.releaseLock() } }
}

export interface FreeChatWire {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
  transformPacket?: (packet: any) => any
  finalize?: () => void
}

/** Fixed provider wires only: callers never supply endpoints or authentication headers. */
export async function forwardFreeChat(request: ChatCompletionRequest,
  options: { label: string; code: string; prepare: () => Promise<FreeChatWire>; fetch?: typeof fetch },
  signal?: AbortSignal, timeout = 120_000): Promise<ForwardResult> {
  const { label, code } = options
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const reset = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(new Error(`${label} request timed out`)), timeout); timer.unref?.() }
  const abort = () => controller.abort(signal?.reason)
  const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    signal?.throwIfAborted()
    const wire = await waitForKiloOperation(options.prepare(), signal)
    signal?.throwIfAborted()
    reset()
    const response = await (options.fetch ?? fetch)(wire.url, {
      method: 'POST', headers: wire.headers,
      redirect: 'error', body: JSON.stringify(wire.body), signal: controller.signal,
    })
    if (!response.ok) {
      const retryAfter = response.headers.get('retry-after')
      const seconds = retryAfter === null ? NaN : Number(retryAfter)
      const retryAfterMs = Number.isFinite(seconds) ? seconds * 1000 : retryAfter ? Date.parse(retryAfter) - Date.now() : NaN
      let payload: any
      try { payload = await readBoundedJson(response) } catch { payload = undefined }
      const message = upstreamError(label, upstreamMessage(payload), response.status)
      cleanup()
      return { success: false, status: response.status, error: message, errorCode: code + '_upstream_error', ...(retryAfterMs > 0 && Number.isFinite(retryAfterMs) ? { retryAfterMs } : {}) }
    }
    const streamPackets = (async function* () {
      for await (const packet of packets(response, request.model, reset, label)) yield wire.transformPacket ? wire.transformPacket(packet) : packet
      wire.finalize?.()
    })()
    if (request.stream) {
      const output = Readable.from((async function* () {
        try {
          for await (const packet of streamPackets) yield 'data: ' + JSON.stringify(packet) + '\n\n'
          yield 'data: [DONE]\n\n'
        } finally { controller.abort(); cleanup() }
      })())
      output.once('close', () => { controller.abort(); cleanup() })
      output.on('error', () => {})
      return { success: true, status: 200, stream: output, skipTransform: true }
    }
    let content = '', reasoning = '', size = 0, last: any = {}, finishReason: string | null = null, usage: unknown
    let tools: any[] = []
    for await (const packet of streamPackets) {
      last = { ...last, ...packet }
      if (packet.usage) usage = packet.usage
      const choice = packet.choices[0], delta = choice?.delta
      if (choice?.finish_reason) finishReason = choice.finish_reason
      content += delta?.content || ''; reasoning += delta?.reasoning_content || ''
      size += JSON.stringify(packet).length
      if (size > 16 * 1024 * 1024) throw new FreeTransportError(`${label} completion exceeds 16 MiB`)
      for (const call of delta?.tool_calls || []) {
        const index = call.index ?? 0
        if (!Number.isSafeInteger(index) || index < 0 || index > 128) throw new FreeTransportError(`Invalid ${label} tool index`)
        const previous = tools[index]
        tools = Object.assign([...tools], { [index]: { id: call.id || previous?.id, type: 'function', function: {
          name: call.function?.name || previous?.function?.name || '', arguments: (previous?.function?.arguments || '') + (call.function?.arguments || ''),
        } } })
      }
    }
    cleanup()
    return { success: true, status: 200, body: { id: last.id, created: last.created, model: request.model, object: 'chat.completion',
      choices: [{ index: 0, finish_reason: finishReason, message: { role: 'assistant', content,
        ...(reasoning ? { reasoning_content: reasoning } : {}), ...(tools.length ? { tool_calls: tools.filter(Boolean) } : {}) } }], ...(usage ? { usage } : {}) } }
  } catch (error) {
    controller.abort(); cleanup()
    return { success: false, status: signal?.aborted ? 499 : timer && controller.signal.aborted && controller.signal.reason?.message === `${label} request timed out` ? 504
      : error instanceof Error && 'status' in error && Number.isInteger(error.status) && Number(error.status) >= 400 && Number(error.status) <= 599 ? Number(error.status) : 502,
      error: signal?.aborted ? `${label} request cancelled` : error instanceof Error ? error.message : `${label} request failed`, errorCode: code + '_request_failed' }
  }
}
