/**
 * Terminal output kept for cursor-based polling. Appends coalesce into chunks and the window is trimmed only
 * once it exceeds twice its limit, so a busy shell no longer copies a megabyte-sized string on every chunk.
 * Reads still expose exactly the last `limit` characters, so polling behaves as with a sliced string.
 */
export interface OutputBuffer { readonly chunks: readonly string[]; readonly length: number; readonly cursor: number }
const CHUNK = 64 * 1024

export const emptyOutput = (cursor = 0): OutputBuffer => ({ chunks: [], length: 0, cursor })

export function appendOutput(buffer: OutputBuffer, data: string, limit: number): OutputBuffer {
  if (!data) return buffer
  const last = buffer.chunks[buffer.chunks.length - 1]
  let chunks = last !== undefined && last.length + data.length <= CHUNK ? [...buffer.chunks.slice(0, -1), last + data] : [...buffer.chunks, data]
  let length = buffer.length + data.length
  if (length > 2 * limit) {
    let drop = 0
    while (length - chunks[drop].length >= limit) { length -= chunks[drop].length; drop++ }
    chunks = chunks.slice(drop)
    // A single oversized write can still exceed the bound on its own.
    if (length > 2 * limit) { chunks = [chunks[0].slice(length - limit), ...chunks.slice(1)]; length = limit }
  }
  return { chunks, length, cursor: buffer.cursor + data.length }
}

/** Output after `from`; `reset` (with the whole retained window) when `from` is outside that window. */
export function readOutput(buffer: OutputBuffer, from: number, limit: number): { data: string; reset: boolean } {
  const start = buffer.cursor - Math.min(buffer.length, limit)
  const reset = from > buffer.cursor || from < start
  let remaining = buffer.cursor - (reset ? start : from)
  const parts: string[] = []
  for (let index = buffer.chunks.length - 1; index >= 0 && remaining > 0; index--) {
    const chunk = buffer.chunks[index]
    parts.push(chunk.length <= remaining ? chunk : chunk.slice(chunk.length - remaining))
    remaining -= chunk.length
  }
  return { data: parts.reverse().join(''), reset }
}
