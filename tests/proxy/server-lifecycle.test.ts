import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, get } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'

import { closeHttpServer } from '../../src/main/proxy/serverLifecycle.ts'

test('server shutdown forcibly closes a streaming connection after the grace period', async t => {
  const sockets = new Set<Socket>()
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/plain' })
    response.write('stream remains open')
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.closeAllConnections())

  const { port } = server.address() as AddressInfo
  const responseStarted = new Promise<void>((resolve, reject) => {
    const request = get(`http://127.0.0.1:${port}`, response => {
      response.once('data', () => resolve())
      response.once('error', () => undefined)
    })
    request.once('error', reject)
  })
  await responseStarted

  const startedAt = Date.now()
  await closeHttpServer(server, sockets, 25)

  assert.ok(Date.now() - startedAt < 500, 'shutdown should not wait indefinitely for the stream')
  assert.ok([...sockets].every(socket => socket.destroyed))
  assert.equal(server.listening, false)
})
