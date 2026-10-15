import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough, Readable } from 'node:stream'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { jsonSseTransform } from '../../src/main/proxy/jsonSseTransform.ts'
import { readUpstreamErrorBody } from '../../src/main/proxy/upstreamError.ts'
import { parseStoredCookies } from '../../src/main/proxy/adapters/storedCookies.ts'
import { watchResponseStream } from '../../src/main/proxy/responseStream.ts'

test('an error emitted before the forwarder attaches is propagated without waiting for timeout', { timeout: 1000 }, async () => {
  const source = new PassThrough()
  source.on('error', () => {})
  source.destroy(new Error('Ollama stream ended before its done event'))
  await nextTurn()
  const output = watchResponseStream(source, 60_000)
  await assert.rejects(async () => {
    for await (const _chunk of output) { /* Drain to surface the stored stream error. */ }
  }, /ended before its done event/)
})

async function parse(chunks: Buffer[]): Promise<unknown[]> {
  const events: unknown[] = []
  const parser = jsonSseTransform((_target, value) => events.push(value), () => {})
  for await (const _chunk of Readable.from(chunks).pipe(parser)) { /* Drain to surface parser errors. */ }
  return events
}

test('SSE handles byte-fragmented UTF-8, BOM, mixed newlines, multiline data, comments and final EOF', async () => {
  const source = Buffer.from('\uFEFF: keepalive\r\ndata: {\rdata: "text": "中文🙂"}\r\rdata: [DONE]')
  assert.deepEqual(await parse(Array.from(source, byte => Buffer.from([byte]))), [{ text: '中文🙂' }, '[DONE]'])
})

test('malformed JSON and oversized SSE frames surface errors instead of silently succeeding', async () => {
  await assert.rejects(parse([Buffer.from('data: not-json\n\n')]), /JSON/)
  await assert.rejects(parse([Buffer.from('data: ' + 'x'.repeat(4 * 1024 * 1024))]), /limit/)
  const line = 'data: ' + ' '.repeat(1024) + '\n'
  await assert.rejects(parse([Buffer.from(line.repeat(4100))]), /limit/)
})

test('upstream error decoding preserves split multilingual text and bounds the output', async () => {
  const source = Buffer.from(JSON.stringify({ error: '模型不存在🙂' }))
  assert.deepEqual(await readUpstreamErrorBody(Readable.from(Array.from(source, byte => Buffer.from([byte])))), { error: '模型不存在🙂' })
  const oversized = await readUpstreamErrorBody(Readable.from(['x'.repeat(70000)])) as { message: string }
  assert.equal(oversized.message.length, 1000)
})

test('saved cookies parse JSON and header forms without losing embedded equals or changing old objects', () => {
  assert.deepEqual(parseStoredCookies('session=abc==; theme=dark'), { session: 'abc==', theme: 'dark' })
  assert.deepEqual(parseStoredCookies('{"session":"abc"}'), { session: 'abc' })
  const original = { session: 'abc' }
  const parsed = parseStoredCookies(original)
  assert.deepEqual(parsed, original)
  assert.notEqual(parsed, original)
  for (const invalid of ['{', 'not-a-cookie', '{"session":1}', 'session=abc\r\nAuthorization: secret']) {
    assert.throws(() => parseStoredCookies(invalid), /cookie/i)
  }
})
