import test, { before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import { OpenCodeV2Client, normalizeOpenCodeV2Message } from '../../src/main/companion/opencodeV2.ts'

const directory = path.resolve('tmp/v2-client-workspace')
const guard = path.resolve('tmp/v2-client-workspace-guard.mjs')
const model = { providerID: 'opencode', modelID: 'mimo-v2.6-flash-free' }
const longText = '保留长文字和全部工具调用。'.repeat(6000)
let server: http.Server, client: OpenCodeV2Client, endpoint: string
let calls: Array<{ method?: string; path: string; body?: any; auth?: string }> = []
let mode = 'normal'
let eventStream: http.ServerResponse | undefined

before(async () => {
  server = http.createServer(async (req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    for await (const part of req) raw += part
    const url = new URL(req.url!, 'http://localhost')
    calls = [...calls, { method: req.method, path: url.pathname + url.search, ...(raw ? { body: JSON.parse(raw) } : {}), auth: req.headers.authorization }]
    res.setHeader('Content-Type', 'application/json')
    const send = (value: unknown) => res.end(JSON.stringify(value))
    if (mode === 'forbidden') { res.statusCode = 403; send({ type: 'FreeTierError', message: 'Free tier does not accept this tool configuration' }); return }
    if (url.pathname === '/api/event') {
      res.setHeader('Content-Type', 'text/event-stream')
      res.write(': connected\r\n\r\n')
      eventStream = res
      return
    }
    if (url.pathname === '/api/info') { send({ version: mode === 'v1' ? '1.18.35' : '2.0.24', pid: 1, urls: [] }); return }
    if (url.pathname === '/api/location') {
      assert.equal(url.searchParams.get('location[directory]'), directory)
      send({ directory, project: { id: 'project', directory: path.dirname(directory), canonical: directory } }); return
    }
    if (url.pathname === '/api/plugin') {
      assert.equal(url.searchParams.get('location[directory]'), directory)
      if (mode === 'cold' && calls.filter(call => call.path.startsWith('/api/plugin')).length === 1) { send({ location: { directory }, data: [] }); return }
      send({ location: { directory }, data: [{ id: 'dailyworkmate-workspace-guard-v2', source: { type: 'local', path: guard }, features: { server: true }, state: mode === 'broken-guard' ? { status: 'failed', error: 'Hook initialization failed' } : { status: 'active' } }] }); return
    }
    if (url.pathname === '/api/session' || url.pathname === '/api/session/ses_test') {
      send({ data: { id: 'ses_test', location: { directory } } }); return
    }
    if (url.pathname === '/api/session/ses_test/message') {
      const cursor = url.searchParams.get('cursor')
      if (!cursor || mode === 'cycle') {
        if (!cursor) assert.equal(url.searchParams.get('order'), 'asc')
        send({ data: [{ id: 'msg_user', type: 'user', text: 'List files' }, { id: 'msg_part1', type: 'assistant', content: [{ type: 'text', text: longText }] }], cursor: { next: 'opaque/+== cursor' } }); return
      }
      assert.equal(cursor, 'opaque/+== cursor')
      assert.equal(url.searchParams.get('order'), null)
      send({ data: [{ id: 'msg_part2', type: 'assistant', error: { type: 'UpstreamError', message: 'A detailed upstream error' }, content: [
        { type: 'tool', id: 'call_read', name: 'read', state: { status: 'completed', input: { path: 'file.txt' }, content: [{ type: 'text', text: 'result' }], metadata: { title: 'file.txt' } } },
        { type: 'text', text: 'partial answer retained' },
      ] }], cursor: {} }); return
    }
    if (url.pathname === '/api/session/ses_test/permission') {
      send({ data: [{ id: 'per_shell', sessionID: mode === 'wrong-session' ? 'ses_other' : 'ses_test', action: 'shell', resources: ['echo example'] }] }); return
    }
    if (url.pathname.endsWith('/wait') && mode === 'wait') return
    if (url.pathname.endsWith('/prompt')) { send({ data: { id: 'msg_new', sessionID: 'ses_test' } }); return }
    if (url.pathname.endsWith('/interrupt')) { send({ interrupted: true }); return }
    res.statusCode = 204; res.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  endpoint = 'http://127.0.0.1:' + (server.address() as { port: number }).port
  client = new OpenCodeV2Client(endpoint, 'private-local-password', directory)
})
beforeEach(() => { eventStream?.destroy(); eventStream = undefined; calls = []; mode = 'normal' })
after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })

test('V2 creates native provider sessions at the explicit directory and authenticates local calls', async () => {
  assert.deepEqual(await client.health(), { healthy: true, version: '2.0.24' })
  assert.deepEqual(await client.location(), { directory, worktree: path.dirname(directory) })
  assert.deepEqual(await client.createSession('A title', model), { id: 'ses_test', directory })
  assert.deepEqual(calls.at(-1)?.body, { title: 'A title', agent: 'build', model: { providerID: 'opencode', id: model.modelID }, location: { directory } })
  assert.ok(calls.every(call => call.auth === 'Basic ' + Buffer.from('opencode:private-local-password').toString('base64')))
})

test('workspace guard handshake fails closed on failed plugins or a different source', async () => {
  await client.assertGuard('dailyworkmate-workspace-guard-v2', guard)
  await assert.rejects(client.assertGuard('dailyworkmate-workspace-guard-v2', guard + '.other'), /source mismatch/)
  mode = 'broken-guard'
  await assert.rejects(client.assertGuard(), /Hook initialization failed/)
})

test('cold V2 locations wait for guard activation and legacy server versions are rejected', async () => {
  mode = 'cold'
  await client.assertGuard('dailyworkmate-workspace-guard-v2', guard)
  assert.equal(calls.length, 2)
  mode = 'v1'
  await assert.rejects(client.health(), /V2 is required.*1\.18\.35/)
})

test('V2 transcript follows every page and keeps long content, tool evidence and errors', async () => {
  const messages = await client.messages('ses_test')
  assert.equal(messages.length, 3)
  assert.equal(messages[1].parts[0].text, longText)
  assert.deepEqual(messages[2].parts[0], { id: 'call_read', type: 'tool', tool: 'read', state: { status: 'completed', input: { path: 'file.txt' }, title: 'file.txt' } })
  assert.equal(messages[2].info.error?.data?.message, 'A detailed upstream error')
  assert.equal(messages[2].parts[1].text, 'partial answer retained')
  mode = 'cycle'
  await assert.rejects(client.messages('ses_test'), /repeated a cursor/)
})

test('prompt uses native model switching, durable instructions and asynchronous completion wait', async () => {
  await client.addHistory('ses_test', 'old conversation')
  assert.deepEqual(calls[0].body, { text: 'old conversation', description: 'Conversation history imported by DailyWorkMate', resume: false })
  await client.prompt('ses_test', { model, system: 'Only the authorized workspace may be read.', text: longText })
  assert.deepEqual(calls.slice(1).map(call => call.path), [
    '/api/session/ses_test/model', '/api/session/ses_test/agent',
    '/api/experimental/session/ses_test/instructions/entries/dailyworkmate-workspace',
    '/api/session/ses_test/prompt', '/api/experimental/session/ses_test/wait',
  ])
  assert.deepEqual(calls[1].body, { model: { providerID: 'opencode', id: model.modelID } })
  assert.deepEqual(calls[3].body, { value: 'Only the authorized workspace may be read.' })
  assert.equal(calls[4].body.text, longText)
})

test('V2 permission conversion and replies stay bound to the current session and never persist approval', async () => {
  assert.deepEqual(await client.permissions('ses_test'), [{ id: 'per_shell', sessionID: 'ses_test', permission: 'shell', patterns: ['echo example'] }])
  await client.reply('ses_test', 'per_shell', true)
  assert.deepEqual(calls.at(-1)?.body, { decision: 'once' })
  await client.reply('ses_test', 'per_shell', false)
  assert.deepEqual(calls.at(-1)?.body, { decision: 'reject' })
  mode = 'wrong-session'
  await assert.rejects(client.permissions('ses_test'), /does not belong/)
})

test('cancellation ends the wait and uses V2 interrupt without resuming queued work', async () => {
  mode = 'wait'
  const controller = new AbortController()
  const pending = client.prompt('ses_test', { model, system: 'readonly', text: 'cancel' }, controller.signal)
  const timeout = setTimeout(() => controller.abort(), 100)
  await assert.rejects(pending, /cancelled/)
  clearTimeout(timeout)
  await client.abort('ses_test')
  assert.equal(calls.at(-1)?.path, '/api/session/ses_test/interrupt?resume=false')
})

test('upstream detail is preserved without echoing authentication; invalid hosts and messages are rejected', async () => {
  mode = 'forbidden'
  await assert.rejects(client.getSession('ses_test'), error => {
    assert.match((error as Error).message, /HTTP 403.*Free tier does not accept this tool configuration/)
    assert.ok(!(error as Error).message.includes('private-local-password'))
    return true
  })
  await assert.rejects(client.subscribeSession('ses_test', () => {}, () => {}), /event subscription failed \(HTTP 403\)/)
  assert.throws(() => new OpenCodeV2Client('https://example.com', 'secret', directory), /local HTTP/)
  assert.throws(() => normalizeOpenCodeV2Message({ id: 'msg_bad', type: 'assistant', content: 'invalid' }), /assistant content/)
  const partial = normalizeOpenCodeV2Message({ id: 'msg_long', type: 'assistant', finish: 'length', content: [{ type: 'text', text: 'keep me' }] })
  assert.equal(partial.parts[0].text, 'keep me')
  assert.match(partial.info.error?.data?.message || '', /output limit/)
})

const eventually = async (check: () => boolean) => {
  const deadline = Date.now() + 2000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Expected event update was not received')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
const event = (id: string, type: string, data: Record<string, unknown>, location = directory) =>
  'data: ' + JSON.stringify({ id, type, location: { directory: location }, data: { sessionID: 'ses_test', ...data } }) + '\r\n\r\n'

test('live events preserve fragmented UTF-8 deltas, reject other scopes and deduplicate event IDs', async () => {
  const received: unknown[] = [], errors: Error[] = []
  const subscription = await client.subscribeSession('ses_test', value => received.push(value), error => errors.push(error))
  assert.equal(calls[0].auth, 'Basic ' + Buffer.from('opencode:private-local-password').toString('base64'))
  eventStream!.write(event('other-session', 'session.text.delta', { sessionID: 'ses_other', assistantMessageID: 'msg_text', ordinal: 0, delta: 'wrong' }))
  eventStream!.write(event('other-location', 'session.text.delta', { assistantMessageID: 'msg_text', ordinal: 0, delta: 'wrong' }, path.resolve('tmp/another-workspace')))
  const delta = event('delta-one', 'session.text.delta', { assistantMessageID: 'msg_text', ordinal: 0, delta: '中文 first' })
  const bytes = Buffer.from(delta)
  const split = bytes.indexOf(Buffer.from('中文')) + 1
  eventStream!.write(bytes.subarray(0, split))
  eventStream!.write(bytes.subarray(split))
  eventStream!.write(delta)
  eventStream!.write(event('end', 'session.text.ended', { assistantMessageID: 'msg_text', ordinal: 0, text: '中文 first complete' }))
  await eventually(() => received.length === 2)
  assert.deepEqual(received, [
    { type: 'text', messageId: 'msg_text', ordinal: 0, text: '中文 first', operation: 'delta' },
    { type: 'text', messageId: 'msg_text', ordinal: 0, text: '中文 first complete', operation: 'end' },
  ])
  subscription.close()
  assert.deepEqual(errors, [])
})

test('live activity reports reasoning and tools without exposing reasoning text and closes on cancellation', async () => {
  const received: unknown[] = [], errors: Error[] = []
  const controller = new AbortController()
  await client.subscribeSession('ses_test', value => received.push(value), error => errors.push(error), controller.signal)
  eventStream!.write(event('reasoning', 'session.reasoning.delta', { assistantMessageID: 'msg_text', ordinal: 0, delta: 'private reasoning must not reach the UI' }))
  eventStream!.write(event('tool', 'session.tool.called', { assistantMessageID: 'msg_text', id: 'tool_one', name: 'read', input: { path: 'file.txt' } }))
  await eventually(() => received.length === 2)
  assert.deepEqual(received, [{ type: 'phase', phase: 'thinking' }, { type: 'phase', phase: 'tool' }])
  const ended = new Promise<void>(resolve => eventStream!.once('close', resolve))
  controller.abort()
  await ended
  assert.deepEqual(errors, [])
})

test('event disconnect and malformed payload notify the caller so it can reconcile message projections', async () => {
  const errors: Error[] = []
  await client.subscribeSession('ses_test', () => {}, error => errors.push(error))
  eventStream!.end()
  await eventually(() => errors.length === 1)
  assert.match(errors[0].message, /ended|closed/)
  await client.subscribeSession('ses_test', () => {}, error => errors.push(error))
  eventStream!.write(event('invalid', 'session.text.delta', { assistantMessageID: 'msg_text', ordinal: -1, delta: 'invalid' }))
  await eventually(() => errors.length === 2)
  assert.match(errors[1].message, /ordinal/)
})
