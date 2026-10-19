import test from 'node:test'
import assert from 'node:assert/strict'
import { appendOutput, emptyOutput, readOutput, type OutputBuffer } from '../../src/main/terminal/outputBuffer.ts'

// Reference: the previous implementation kept `(output + data).slice(-limit)` and a running cursor.
function reference(chunks: string[], limit: number) {
  let output = '', cursor = 0
  for (const chunk of chunks) { output = (output + chunk).slice(-limit); cursor += chunk.length }
  return { output, cursor, read: (from: number) => {
    const start = cursor - output.length
    const reset = from > cursor || from < start
    return { data: output.slice(reset ? 0 : from - start), reset }
  } }
}

test('polling returns exactly what the sliced-string window returned, for any cursor', () => {
  const limit = 1000
  let seed = 7
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
  const chunks = Array.from({ length: 400 }, (_, index) => String.fromCharCode(97 + index % 26).repeat(1 + Math.floor(random() * (random() < 0.05 ? 2500 : 90))))
  let buffer: OutputBuffer = emptyOutput()
  for (const [index, chunk] of chunks.entries()) {
    buffer = appendOutput(buffer, chunk, limit)
    const expected = reference(chunks.slice(0, index + 1), limit)
    assert.equal(buffer.cursor, expected.cursor)
    assert.ok(buffer.length <= 2 * limit, 'memory stays bounded')
    for (const from of [0, expected.cursor, expected.cursor + 1, expected.cursor - 1, expected.cursor - limit, expected.cursor - limit - 1, Math.floor(random() * (expected.cursor + 5))]) {
      if (from < 0) continue
      assert.deepEqual(readOutput(buffer, from, limit), expected.read(from), `chunk ${index}, cursor ${from}`)
    }
  }
})

test('appending never mutates the previous buffer and trimming is amortized', () => {
  const first = appendOutput(emptyOutput(), 'abc', 10)
  const second = appendOutput(first, 'def', 10)
  assert.deepEqual(first, { chunks: ['abc'], length: 3, cursor: 3 })
  assert.equal(readOutput(second, 0, 10).data, 'abcdef')
  // An emptied window keeps its cursor: older readers get a reset, current readers nothing.
  const cleared = emptyOutput(second.cursor)
  assert.deepEqual(readOutput(cleared, 0, 10), { data: '', reset: true })
  assert.deepEqual(readOutput(cleared, 6, 10), { data: '', reset: false })
  // A single oversized write is cut to the limit at once.
  const huge = appendOutput(emptyOutput(), 'x'.repeat(50), 10)
  assert.equal(huge.length, 10)
  assert.deepEqual(readOutput(huge, 0, 10), { data: 'x'.repeat(10), reset: true })
})
