import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { Agent as HttpAgent, createServer, get } from 'node:http'
import { Agent as HttpsAgent } from 'node:https'
import { createOllamaAgents, limitConnection } from '../../src/main/proxy/connectionAgents.ts'

test('HTTP and TLS connection deadlines follow the request setting beyond ten seconds', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  for (const [Agent, key, event] of [
    [HttpAgent, 'httpAgent', 'connect'],
    [HttpsAgent, 'httpsAgent', 'secureConnect'],
  ] as const) {
    const socket = new PassThrough()
    const failures: Error[] = []
    socket.on('error', error => failures.push(error))
    const create = context.mock.method(Agent.prototype, 'createConnection', () => socket)
    const agent = createOllamaAgents(60_000)[key]
    agent.createConnection({}, () => {})
    context.mock.timers.tick(10_001)
    assert.equal(socket.destroyed, false, `${key} must allow the saved 60s timeout`)
    socket.emit(event)
    context.mock.timers.tick(60_000)
    assert.equal(socket.destroyed, false, `${key} must stop timing once connected`)
    assert.deepEqual(failures, [])
    socket.destroy()
    agent.destroy()
    create.mock.restore()
  }
})

test('stalled HTTP and TLS connections still expire at the configured deadline', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  for (const [Agent, key] of [[HttpAgent, 'httpAgent'], [HttpsAgent, 'httpsAgent']] as const) {
    const socket = new PassThrough()
    const failed = new Promise<Error & { code?: string }>(resolve => socket.once('error', resolve))
    const create = context.mock.method(Agent.prototype, 'createConnection', () => socket)
    const agent = createOllamaAgents(25_000)[key]
    agent.createConnection({}, () => {})
    context.mock.timers.tick(24_999)
    assert.equal(socket.destroyed, false)
    context.mock.timers.tick(1)
    const error = await failed
    assert.match(error.message, /connection timed out after 25000ms/)
    assert.equal(error.code, 'ETIMEDOUT')
    assert.equal(socket.destroyed, true)
    agent.destroy()
    create.mock.restore()
  }
})

test('a real HTTP connection can wait for output longer than its connection deadline', async () => {
  const server = createServer((_req, res) => { setTimeout(() => res.end('OK'), 150) })
  const { httpAgent, httpsAgent } = createOllamaAgents(75)
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const body = await new Promise<string>((resolve, reject) => {
      const req = get(`http://127.0.0.1:${address.port}`, { agent: httpAgent }, res => {
        let text = ''
        res.on('data', chunk => { text += chunk })
        res.once('end', () => resolve(text))
        res.once('error', reject)
      })
      req.once('error', reject)
    })
    assert.equal(body, 'OK')
  } finally {
    httpAgent.destroy()
    httpsAgent.destroy()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('unreachable connection expires, but a connected socket can keep generating', async () => {
  const stalled = new PassThrough()
  const failed = new Promise<Error>(resolve => stalled.once('error', resolve))
  limitConnection(stalled, 'connect', 20)
  const connected = new PassThrough()
  limitConnection(connected, 'connect', 20)
  connected.emit('connect')
  await delay(60)
  assert.match((await failed).message, /connection timed out/)
  assert.equal(stalled.destroyed, true)
  assert.equal(connected.destroyed, false)
  assert.equal(connected.listenerCount('connect'), 0)
  connected.destroy()
})

test('TLS handshake must complete and closed connections remove timeout listeners', async () => {
  const socket = new PassThrough()
  const failed = new Promise<Error>(resolve => socket.once('error', resolve))
  limitConnection(socket, 'secureConnect', 20)
  socket.emit('connect')
  await delay(60)
  assert.match((await failed).message, /connection timed out/)
  assert.equal(socket.listenerCount('secureConnect'), 0)
  const closed = new PassThrough()
  limitConnection(closed, 'secureConnect', 20)
  closed.destroy()
  await delay(40)
  assert.equal(closed.listenerCount('secureConnect'), 0)
})
