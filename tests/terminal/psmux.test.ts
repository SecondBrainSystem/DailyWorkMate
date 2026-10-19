import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:net'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { discoverPsmux } from '../../src/main/terminal/psmux.ts'

const windows = process.platform === 'win32'
const listen = (server: Server) => new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)))
const key = 'a'.repeat(32)

test('one malformed registry entry or a silent port never blocks discovery (or quitting)', { skip: !windows && 'psmux discovery runs on Windows only' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dailyworkmate-psmux-'))
  const sockets = new Set<import('node:net').Socket>()
  // A real psmux session answers AUTH with OK.
  const psmux = createServer(socket => { sockets.add(socket); socket.on('data', () => socket.write('OK\n')) })
  // Another program reusing a stale port: accepts but never answers.
  const silent = createServer(socket => { sockets.add(socket) })
  try {
    const [livePort, silentPort] = [await listen(psmux), await listen(silent)]
    const write = (name: string, port: string, keyValue: string, pid: string) => Promise.all([
      writeFile(path.join(root, name + '.port'), port), writeFile(path.join(root, name + '.key'), keyValue), writeFile(path.join(root, name + '.pid'), pid)])
    await write('live', String(livePort), key, '1234')
    await write('bad-key', String(livePort), 'short', '1234')
    await write('bad-pid', String(livePort), key, 'not-a-pid')
    await write('silent', String(silentPort), key, '1234')
    await writeFile(path.join(root, 'missing-key.port'), String(livePort))
    await mkdir(path.join(root, 'nested.port'))
    const started = Date.now()
    const sessions = await discoverPsmux([root, path.join(root, 'absent'), 'relative-dir'])
    assert.deepEqual(sessions.map(session => session.name), ['live'])
    assert.ok(Date.now() - started < 5000, 'the silent port times out once instead of failing the scan')
  } finally {
    for (const socket of sockets) socket.destroy()
    psmux.close(); silent.close()
    await rm(root, { recursive: true, force: true })
  }
})
