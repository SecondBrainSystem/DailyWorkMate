import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { createServer, request } from 'node:http'
import axios, { AxiosError } from 'axios'
import { requestOllama } from '../../src/main/ollama/request.ts'

test('a failed TCP handshake reconnects once and delivers the prompt only once', async () => {
  let attempts = 0
  const received: unknown[] = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    received.push(JSON.parse(body))
    res.setHeader('Content-Type', 'application/json')
    res.end('{"message":{"content":"OK"},"done":true}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const data = { model: 'minimax-m3:cloud', messages: [{ role: 'user', content: 'hi' }] }
  try {
    const response = await requestOllama({
      url: `http://127.0.0.1:${address.port}/api/chat`, method: 'POST', data, timeout: 1000, proxy: false,
      transport: { request: (...args: Parameters<typeof request>) => {
        attempts++
        if (attempts > 1) return request(...args)
        class FailedConnection extends PassThrough { setTimeout() { return this } }
        const failed = new FailedConnection()
        process.nextTick(() => failed.destroy(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT', syscall: 'connect' })))
        return failed
      } },
    }, 1000)
    assert.equal(response.status, 200)
    assert.equal(attempts, 2)
    assert.deepEqual(received, [data])
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('response failures and cancellations never replay a prompt', async context => {
  for (const detail of [
    { code: 'ECONNABORTED', syscall: undefined },
    { code: 'ETIMEDOUT', syscall: 'read' },
    { code: 'ECONNRESET', syscall: 'read' },
    { code: 'ERR_CANCELED', syscall: undefined },
  ]) {
    const failure = AxiosError.from(Object.assign(new Error('failed after connection'), detail), detail.code)
    const send = context.mock.method(axios, 'request', async () => { throw failure })
    await assert.rejects(requestOllama({ url: 'http://example.invalid/api/chat' }, 60_000), error => error === failure)
    assert.equal(send.mock.callCount(), 1)
    send.mock.restore()
  }
})

test('connection retries are bounded and consume the original timeout budget', async context => {
  context.mock.timers.enable({ apis: ['Date'] })
  const failure = AxiosError.from(Object.assign(new Error('connect ETIMEDOUT'), { syscall: 'connect' }), 'ETIMEDOUT')
  const timeouts: unknown[] = []
  const send = context.mock.method(axios, 'request', async config => {
    timeouts.push(config.timeout)
    context.mock.timers.tick(21_000)
    throw failure
  })
  await assert.rejects(requestOllama({ timeout: 60_000 }, 60_000), error => error === failure)
  assert.deepEqual(timeouts, [60_000, 39_000])
  assert.equal(send.mock.callCount(), 2)
})

test('an exhausted budget or a cancelled client prevents reconnection', async context => {
  context.mock.timers.enable({ apis: ['Date'] })
  for (const cancel of [false, true]) {
    const controller = new AbortController()
    const failure = AxiosError.from(Object.assign(new Error('connect ETIMEDOUT'), { syscall: 'connect' }), 'ETIMEDOUT')
    const send = context.mock.method(axios, 'request', async () => {
      if (cancel) controller.abort()
      else context.mock.timers.tick(60_000)
      throw failure
    })
    await assert.rejects(requestOllama({ timeout: 60_000, signal: controller.signal }, 60_000), error => error === failure)
    assert.equal(send.mock.callCount(), 1)
    send.mock.restore()
  }
})
