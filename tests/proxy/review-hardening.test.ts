import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { authorizeApiKey } from '../../src/main/proxy/apiKeyAuth.ts'
import { isLoopbackAddress, networkExposureError } from '../../src/shared/proxyListeners.ts'
import { buildUpstreamUrl } from '../../src/main/proxy/upstreamUrl.ts'
import { MAX_RETRY_AFTER_MS, UPSTREAM_TIMEOUT, UPSTREAM_UNREACHABLE, isTransportFailure, retryAfter, sameAccountRetryDelay, upstreamFailure } from '../../src/main/proxy/upstreamFailure.ts'
import { afterStream, createStreamRecorder } from '../../src/main/proxy/responseStream.ts'
import { awaitFirstOutput } from '../../src/main/proxy/firstOutput.ts'
import { extractTokenCount } from '../../src/main/proxy/tokenUsage.ts'

const key = { id: 'k1', key: 'secret-key', enabled: true }

test('loopback detection covers IPv4, IPv6 and IPv4-mapped IPv6 addresses', () => {
  for (const address of ['127.0.0.1', '127.8.9.10', '::1', '[::1]', '::ffff:127.0.0.1', 'localhost']) assert.equal(isLoopbackAddress(address), true, address)
  for (const address of ['0.0.0.0', '192.168.1.5', '::ffff:192.168.1.5', '::', 'fe80::1', '', undefined]) assert.equal(isLoopbackAddress(address), false, String(address))
})

test('requests from the network need a valid key even when key checking is turned off', () => {
  const remote = { localAddress: '192.168.1.2', remoteAddress: '192.168.1.9' }
  const local = { localAddress: '127.0.0.1', remoteAddress: '::ffff:127.0.0.1' }
  assert.deepEqual(authorizeApiKey({ enableApiKey: false, apiKeys: [key], ...local }), { ok: true })
  assert.equal(authorizeApiKey({ enableApiKey: false, apiKeys: [], ...remote }).ok, false)
  assert.equal(authorizeApiKey({ enableApiKey: false, apiKeys: [key], providedKey: 'wrong', ...remote }).ok, false)
  assert.equal(authorizeApiKey({ enableApiKey: false, apiKeys: [{ ...key, enabled: false }], providedKey: key.key, ...remote }).ok, false)
  assert.deepEqual(authorizeApiKey({ enableApiKey: false, apiKeys: [key], providedKey: key.key, ...remote }), { ok: true, keyId: 'k1' })
  // A 0.0.0.0 listener reached through its loopback address stays a local request.
  assert.equal(authorizeApiKey({ enableApiKey: false, apiKeys: [], localAddress: '127.0.0.1', remoteAddress: '192.168.1.9' }).ok, false)
  assert.equal(authorizeApiKey({ enableApiKey: true, apiKeys: [key], ...local }).ok, false)
  assert.equal(authorizeApiKey({ enableApiKey: false, apiKeys: [] }).ok, false, 'unknown socket addresses are treated as remote')
})

test('configured LAN listeners require an enabled key; loopback-only setups do not', () => {
  assert.equal(networkExposureError({ proxyHost: '127.0.0.1', enableApiKey: false, apiKeys: [] }), undefined)
  assert.equal(networkExposureError({ proxyHost: '0.0.0.0', enableApiKey: true, apiKeys: [key] }), undefined)
  assert.match(networkExposureError({ proxyHost: '0.0.0.0', enableApiKey: false, apiKeys: [key] }) || '', /0\.0\.0\.0/)
  assert.match(networkExposureError({ proxyHost: '127.0.0.1', additionalProxyListeners: [{ port: 1, host: '192.168.1.2' }], enableApiKey: true, apiKeys: [{ ...key, enabled: false }] }) || '', /192\.168\.1\.2/)
  assert.match(networkExposureError({ proxyHost: '::', enableApiKey: true, apiKeys: [{ ...key, key: '  ' }] }) || '', /::/)
})

test('forwarder and direct connections share one URL rule', () => {
  assert.equal(buildUpstreamUrl('https://api.example.com/v1/', '/v1/chat/completions'), 'https://api.example.com/v1/chat/completions')
  assert.equal(buildUpstreamUrl('https://api.example.com/v1', '/chat/completions'), 'https://api.example.com/v1/chat/completions')
  assert.equal(buildUpstreamUrl('https://api.example.com/v1beta', '/v1/chat/completions'), 'https://api.example.com/v1beta/chat/completions')
  assert.equal(buildUpstreamUrl('https://api.example.com', 'v1/messages'), 'https://api.example.com/v1/messages')
  // A /v1 segment in the middle of the base is not a version suffix.
  assert.equal(buildUpstreamUrl('https://api.example.com/v1/openai', '/v1/chat/completions'), 'https://api.example.com/v1/openai/v1/chat/completions')
})

test('Retry-After is honoured only within a bounded wait', () => {
  assert.deepEqual(retryAfter({ 'retry-after': '3' }), { retryAfterMs: 3000 })
  assert.deepEqual(retryAfter({ 'Retry-After': 2 }), { retryAfterMs: 2000 })
  assert.deepEqual(retryAfter({ get: (name: string) => name === 'retry-after' ? '1.5' : undefined }), { retryAfterMs: 1500 })
  assert.ok((retryAfter({ 'retry-after': new Date(Date.now() + 60_000).toUTCString() }).retryAfterMs || 0) > 50_000)
  assert.deepEqual(retryAfter({ 'retry-after': 'soon' }), {})
  assert.deepEqual(retryAfter(undefined), {})
  assert.equal(sameAccountRetryDelay({}, 5000), 5000)
  assert.equal(sameAccountRetryDelay({ retryAfterMs: 1200 }, 5000), 1200)
  assert.equal(sameAccountRetryDelay({ retryAfterMs: MAX_RETRY_AFTER_MS + 1 }, 5000), undefined)
})

test('thrown errors map to one status rule; only transport failures are marked as such', () => {
  const refused = upstreamFailure(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))
  assert.deepEqual([refused.status, refused.errorCode], [502, UPSTREAM_UNREACHABLE])
  const timedOut = upstreamFailure(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }))
  assert.deepEqual([timedOut.status, timedOut.errorCode], [504, UPSTREAM_TIMEOUT])
  assert.equal(upstreamFailure(new Error('HTTP 429 from upstream')).status, 429)
  assert.equal(upstreamFailure(Object.assign(new Error('bad'), { status: 503 })).status, 503)
  const controller = new AbortController(); controller.abort()
  assert.equal(upstreamFailure(new Error('aborted'), controller.signal).status, 499)
  assert.equal(isTransportFailure(refused), true)
  assert.equal(isTransportFailure({ errorCode: undefined }), false)
})

test('stream recorder keeps the log prefix and the usage line with constant memory', () => {
  const recorder = createStreamRecorder(50)
  const chunk = 'data: {"choices":[{"delta":{"content":"' + 'x'.repeat(200) + '"}}]}\n'
  for (let index = 0; index < 5000; index++) { recorder.append(chunk); recorder.line(chunk.trim()) }
  const usage = 'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":5,"total_tokens":12}}'
  recorder.append(usage + '\n'); recorder.line(usage)
  for (let index = 0; index < 100; index++) { recorder.append(chunk); recorder.line(chunk.trim()) }
  const body = recorder.body()
  assert.ok(body.startsWith(chunk.slice(0, 50)))
  assert.ok(body.length < 20_000, `body stays bounded (${body.length})`)
  assert.equal(extractTokenCount(body), 12)
  const short = createStreamRecorder(1000)
  short.append('data: [DONE]\n')
  assert.equal(short.body(), 'data: [DONE]\n')
  const off = createStreamRecorder(0)
  off.append(usage); off.line(usage)
  assert.equal(extractTokenCount(off.body()), 12)
})

test('a finish-only stream fails over but is marked as a completed (reachable) node', async () => {
  const source = new PassThrough()
  const pending = awaitFirstOutput(source, 5000)
  source.end('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
  const result = await pending
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.finished, true)
  const silent = new PassThrough()
  const closed = awaitFirstOutput(silent, 5000)
  silent.end('data: [DONE]\n\n')
  const broken = await closed
  assert.equal(broken.ok, false)
  if (!broken.ok) assert.equal(broken.finished, undefined)
})

test('session cleanup runs once on normal end, on error and on early close', async () => {
  for (const finishStream of [
    (stream: PassThrough) => { stream.end(); stream.resume() },
    (stream: PassThrough) => stream.destroy(new Error('upstream failed')),
    (stream: PassThrough) => stream.destroy(),
  ]) {
    const stream = new PassThrough()
    stream.on('error', () => {})
    let calls = 0
    const done = new Promise<void>(resolve => afterStream(stream, 'qa', () => { calls += 1; resolve() }))
    finishStream(stream)
    await done
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(calls, 1)
  }
})
