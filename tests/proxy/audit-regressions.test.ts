import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough, Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { awaitFirstOutput } from '../../src/main/proxy/firstOutput.ts'
import { watchResponseStream } from '../../src/main/proxy/responseStream.ts'
import { createOpenAISseToClaudeStream } from '../../src/main/proxy/ollamaProtocol.ts'
import { normalizeFeatureRequest } from '../../src/main/proxy/modelFeatures.ts'
import { RequestLogManager } from '../../src/main/requestLogs/manager.ts'
import { AppLogManager } from '../../src/main/appLogs/manager.ts'
import { findModelMapping } from '../../src/shared/modelMapping.ts'
import { configurationBackup, readConfigurationBackup } from '../../src/shared/configBackup.ts'
import { redactSecrets } from '../../src/shared/redaction.ts'
import { localDateKey } from '../../src/shared/localDate.ts'
import { internalProxyKey, isInternalProxyKey } from '../../src/main/proxy/internalAuth.ts'
import type { AppConfig, RequestLogEntry } from '../../src/main/store/types.ts'
import type { ChatCompletionRequest } from '../../src/main/proxy/types'

const event = (delta: object, finish_reason: string | null = null) => 'data: ' + JSON.stringify({ choices: [{ delta, finish_reason }] }) + '\n\n'
test('desktop authentication rejects malformed and multibyte keys without throwing', () => {
  assert.equal(isInternalProxyKey(internalProxyKey), true)
  for (const invalid of [undefined, {}, 'é'.repeat(64), 'g'.repeat(64), '', '0'.repeat(63)]) {
    assert.equal(isInternalProxyKey(invalid), false)
  }
})
async function collect(stream: NodeJS.ReadableStream) { let result = ''; for await (const chunk of stream) result += chunk.toString(); return result }

test('DONE and finish-only upstream streams fail before HTTP success', async () => {
  for (const body of ['data: [DONE]\n\n', event({}, 'stop') + 'data: [DONE]\n\n', event({ role: 'assistant' })]) {
    const result = await awaitFirstOutput(Readable.from([body]), 1000)
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'stream_error')
  }
})

test('reasoning, tool calls and split UTF-8 are replayed unchanged', async () => {
  for (const delta of [{ reasoning_content: '思考' }, { content: '你好' }, { tool_calls: [{ index: 0, function: { name: 'read' } }] }]) {
    const bytes = Buffer.from(event(delta) + event({}, 'stop') + 'data: [DONE]\n\n')
    const source = Readable.from(Array.from(bytes, byte => Buffer.from([byte])))
    const result = await awaitFirstOutput(source, 1000)
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(await collect(result.stream), bytes.toString())
  }
})

test('cancelling a preflight destroys its upstream and distinguishes cancellation', async () => {
  const source = new PassThrough(), controller = new AbortController()
  const pending = awaitFirstOutput(source, 1000, controller.signal)
  controller.abort()
  const result = await pending
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reason, 'aborted')
  assert.equal(source.destroyed, true)
})

test('idle stream timeout cancels a node after its first output', async () => {
  const source = new PassThrough(), output = watchResponseStream(source, 1000)
  const failure = new Promise<Error>(resolve => output.once('error', resolve))
  output.resume(); source.write('first output')
  assert.match((await failure).message, /timed out/)
  await delay(10)
  assert.equal(source.destroyed, true)
})

test('active chunks reset the idle timeout and successful completion removes the timer', async () => {
  const source = new PassThrough(), output = watchResponseStream(source, 1000)
  const pending = collect(output)
  source.write('one'); await delay(600); source.write('two'); await delay(600); source.end('three')
  assert.equal(await pending, 'onetwothree')
})

test('Claude blocks never receive deltas after stop, including interleaved tools', async () => {
  const input = event({ reasoning_content: 'plan' }) + event({ content: 'answer' })
    + event({ tool_calls: [{ index: 0, id: 'one', function: { name: 'read', arguments: '{"path":' } }, { index: 1, id: 'two', function: { name: 'list', arguments: '{' } }] })
    + event({ tool_calls: [{ index: 0, function: { arguments: '"a"}' } }, { index: 1, function: { arguments: '}' } }] })
    + event({}, 'tool_calls') + 'data: [DONE]\n\n'
  const events = (await collect(Readable.from([input]).pipe(createOpenAISseToClaudeStream('qa')))).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
  const open = new Set<number>(), closed = new Set<number>(), args = new Map<number, string>()
  for (const item of events) {
    if (item.type === 'content_block_start') { assert.equal(open.size, 0); open.add(item.index) }
    if (item.type === 'content_block_delta') { assert.ok(open.has(item.index)); assert.ok(!closed.has(item.index)); if (item.delta.partial_json) args.set(item.index, (args.get(item.index) || '') + item.delta.partial_json) }
    if (item.type === 'content_block_stop') { assert.ok(open.has(item.index)); open.delete(item.index); closed.add(item.index) }
  }
  assert.equal(open.size, 0)
  assert.deepEqual([...args.values()].map(value => JSON.parse(value)), [{ path: 'a' }, {}])
})

test('model aliases use exact matches and deterministic escaped multi-wildcards', () => {
  const map = { 'gpt-*': 'broad', 'gpt-4*': 'specific', 'gpt-4o': 'exact', 'a.b-*': 'escaped', 'prefix*middle*suffix': 'multiple' }
  assert.equal(findModelMapping('gpt-4o', map), 'exact')
  assert.equal(findModelMapping('gpt-4.1', map), 'specific')
  assert.equal(findModelMapping('gpt-5', map), 'broad')
  assert.equal(findModelMapping('axb-x', map), undefined)
  assert.equal(findModelMapping('a.b-x', map), 'escaped')
  assert.equal(findModelMapping('prefix-one-middle-two-suffix', map), 'multiple')
})

test('developer roles remain normalized when vision is disabled without mutating input', () => {
  const input = { model: 'qa', enable_vision: false, messages: [{ role: 'developer', content: 'rules' }, { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }] }] } as unknown as ChatCompletionRequest
  const original = JSON.stringify(input)
  const normalized = normalizeFeatureRequest(input)
  assert.equal(normalized.messages[0].role, 'system')
  assert.equal((normalized.messages[1].content as unknown[]).length, 1)
  assert.equal(JSON.stringify(input), original)
})

test('configuration backups exclude service credentials and ignore injected secret fields', () => {
  const config = { theme: 'light', apiKeys: [{ key: 'secret' }], managementApiSecret: 'admin', internalProxyKey: 'internal' } as unknown as AppConfig
  assert.deepEqual(configurationBackup(config), { theme: 'light' })
  assert.deepEqual(readConfigurationBackup({ config }), { theme: 'light' })
  assert.throws(() => readConfigurationBackup([]), /Invalid/)
  assert.throws(() => readConfigurationBackup({ version: 1 }), /No application/)
})

test('console and structured application logs redact secrets recursively', () => {
  const payload = { authorization: 'secret', nested: { cookies: { session: 'cookie' }, apiKey: 'key' }, message: 'Authorization: Bearer abc.def.xyz', normal: 'keep' }
  const result = JSON.stringify(redactSecrets(payload))
  for (const secret of ['abc.def.xyz', '"secret"', '"cookie"', '"key"']) assert.ok(!result.includes(secret))
  assert.match(result, /keep/)
  assert.equal(payload.authorization, 'secret')
})

test('log completion keeps inputs, supports pagination, and persists retention pruning', async t => {
  const root = mkdtempSync(join(tmpdir(), 'audit-log-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const manager = new RequestLogManager({ storageDir: root, config: { enabled: true, maxEntries: 50, includeBodies: true, maxBodyChars: 8000 } })
  await manager.initialize()
  const entry = (timestamp: number, model: string) => ({ timestamp, model, status: 'success', statusCode: 200, method: 'POST', url: '/v1/chat/completions', responseStatus: 200, latency: 0, isStream: true, userInput: 'hello', requestBody: '{"messages":[]}' }) as Omit<RequestLogEntry, 'id'>
  const old = manager.addRequestLog(entry(Date.now() - 10 * 86400000, 'old'))
  const first = manager.addRequestLog(entry(Date.now() - 1000, 'qa-first'))
  manager.addRequestLog(entry(Date.now(), 'qa-second'))
  manager.updateRequestLog(first.id, { userInput: undefined, requestBody: undefined, latency: 123 })
  assert.equal(manager.getRequestLogById(first.id)?.userInput, 'hello')
  assert.equal(manager.getRequestLogById(first.id)?.requestBody, '{"messages":[]}')
  assert.equal(manager.getRequestLogs(1, { keyword: 'qa', offset: 1, summaryOnly: true })[0].id, first.id)
  assert.equal(manager.getRequestLogs(1, { summaryOnly: true })[0].requestBody, undefined)
  manager.setRetentionDays(2); manager.flushSync()
  assert.equal(manager.getRequestLogById(old.id), undefined)
  assert.ok(!readFileSync(join(root, 'request-logs.ndjson'), 'utf8').includes('"model":"old"'))
})

test('application log persistence sanitizes even caller-supplied entries', async t => {
  const root = mkdtempSync(join(tmpdir(), 'audit-app-log-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const manager = new AppLogManager({ storageDir: root }); await manager.initialize()
  manager.addLog({ id: 'qa', timestamp: Date.now(), level: 'info', message: 'apiKey=TOPSECRET', data: { managementApiSecret: 'ADMINSECRET' } }); manager.flushSync()
  const raw = readFileSync(join(root, 'app-logs.ndjson'), 'utf8')
  assert.ok(!raw.includes('TOPSECRET')); assert.ok(!raw.includes('ADMINSECRET'))
})

test('daily statistics keys use the local calendar date', () => {
  const date = new Date(2026, 9, 11, 0, 5)
  assert.equal(localDateKey(date), '2026-10-11')
})
