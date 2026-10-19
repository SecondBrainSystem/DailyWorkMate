import test, { before } from 'node:test'
import assert from 'node:assert/strict'
import { readChatCompletionStream } from '../../src/renderer/src/lib/chatClient.ts'
import { i18nReady } from './i18nSetup.ts'

before(() => i18nReady)

test('chat accepts multiline SSE and CR framing split across UTF-8 bytes', async () => {
  const encoded = new TextEncoder().encode('\uFEFF:keep-alive\rdata: {"choices":\rdata: [{"delta":{"content":"你好"},"finish_reason":"stop"}]}\r\rdata: [DONE]\r\r')
  const response = new Response(new ReadableStream({ start(controller) {
    for (const byte of encoded) controller.enqueue(Uint8Array.of(byte))
    controller.close()
  } }))
  const deltas: unknown[] = []
  await readChatCompletionStream(response, delta => deltas.push(delta))
  assert.deepEqual(deltas, [{ content: '你好' }])
  assert.equal(response.body?.locked, false)
})

test('chat surfaces upstream errors even without an error.message field', async () => {
  const response = new Response('data: {"error":"model unavailable"}\n\ndata: [DONE]\n\n')
  await assert.rejects(readChatCompletionStream(response, () => {}), /model unavailable/)
  assert.equal(response.body?.locked, false)
})

test('HTTP errors retain the status and both supported error body shapes', async () => {
  for (const error of ['Node A timed out', {message:'Node A timed out'}]) {
    await assert.rejects(readChatCompletionStream(new Response(JSON.stringify({error}), {status:504}), () => {}), /HTTP 504: Node A timed out/)
  }
})

test('chat limits unterminated SSE data and cancels the reader on parse failure', { timeout: 2000 }, async () => {
  let cancelled = false
  const response = new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('data: ' + 'x'.repeat(4 * 1024 * 1024 + 1)))
  }, cancel() { cancelled = true } }))
  await assert.rejects(readChatCompletionStream(response, () => {}), /4 MiB limit/)
  assert.equal(cancelled, true)
  assert.equal(response.body?.locked, false)
})
test('output length limits report incomplete replies after retaining the last delta', async () => {
  const received: string[] = []
  const response = new Response('data: {"choices":[{"delta":{"content":"Partial translation"},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n')
  await assert.rejects(readChatCompletionStream(response, delta => { received.push(delta.content || '') }), /incomplete/)
  assert.deepEqual(received, ['Partial translation'])
})
