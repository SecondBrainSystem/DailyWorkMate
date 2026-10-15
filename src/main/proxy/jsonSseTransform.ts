import { Transform } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'

/** Decode UTF-8 and SSE framing before parsing JSON; never discard upstream errors. */
export function jsonSseTransform(
  consume: (target: Transform, data: any | '[DONE]') => void,
  finish: (target: Transform) => void,
): Transform {
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  let dataLines: string[] = []
  let eventLength = 0
  let firstChunk = true
  const maxEventLength = 4 * 1024 * 1024
  const dispatch = (target: Transform) => {
    if (!dataLines.length) return
    const raw = dataLines.join('\n').trim()
    dataLines = []
    eventLength = 0
    if (raw) consume(target, raw === '[DONE]' ? raw : JSON.parse(raw))
  }
  const line = (target: Transform, value: string) => {
    const text = value
    if (text.length > maxEventLength) throw new Error('SSE line exceeds the 4 MiB limit')
    if (!text) dispatch(target)
    else if (text === 'data' || text.startsWith('data:')) {
      eventLength += text.length
      if (eventLength > maxEventLength) throw new Error('SSE event exceeds the 4 MiB limit')
      dataLines.push(text.slice(5).replace(/^ /, ''))
    }
  }
  const parse = (target: Transform, text: string, final = false) => {
    if (firstChunk && text) { text = text.replace(/^\uFEFF/, ''); firstChunk = false }
    buffer += text
    let start = 0
    for (let index = 0; index < buffer.length; index++) {
      const char = buffer[index]
      if (char !== '\r' && char !== '\n') continue
      if (char === '\r' && index === buffer.length - 1 && !final) break
      line(target, buffer.slice(start, index))
      if (char === '\r' && buffer[index + 1] === '\n') index++
      start = index + 1
    }
    buffer = buffer.slice(start)
    if (buffer.length > maxEventLength) throw new Error('SSE line exceeds the 4 MiB limit')
  }
  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        parse(this, decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
        callback()
      } catch (error) { callback(error instanceof Error ? error : new Error(String(error))) }
    },
    flush(callback) {
      try {
        parse(this, decoder.end(), true)
        if (buffer) line(this, buffer)
        dispatch(this)
        finish(this)
        callback()
      } catch (error) { callback(error instanceof Error ? error : new Error(String(error))) }
    },
  })
}
