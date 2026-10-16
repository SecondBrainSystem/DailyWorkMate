import test, { before } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

let OpenCodeTerminalService, terminalSize
before(async () => {
  await mkdir('tmp/qa', { recursive: true })
  const output = path.resolve('tmp/qa/terminal-tests.mjs')
  await build({ entryPoints: ['src/main/companion/terminal.ts'], outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external' })
  ;({ OpenCodeTerminalService, terminalSize } = await import(pathToFileURL(output).href))
})
const input = { workspaceId: 'qa', model: 'qa-model', cols: 100, rows: 30 }
function fixture(prepare) {
  const state = { spawns: [], writes: [], sizes: [], killed: 0, disposed: 0, released: [], attached: new Set(), nextAttachment: 0, serverAlive: true }
  const runtime = { executable: 'opencode.exe', address: 'http://127.0.0.1:34567', password: 'private-main-password', directory: process.cwd(), remoteSessionId: 'ses_qa', sessionId: 'v2:qa:ses_qa' }
  // Mirrors OpenCodeService: every prepared client holds a token and the last release stops the server.
  const attach = value => { const attachment = ++state.nextAttachment; state.attached.add(attachment); return { ...value, attachment } }
  const agent = {
    prepareTerminal: async terminalInput => attach(prepare ? await prepare(terminalInput) : runtime),
    terminalAttachmentAlive: attachment => state.serverAlive && state.attached.has(attachment),
    releaseTerminal: async attachment => { state.released.push(attachment); if (state.attached.delete(attachment) && state.attached.size === 0) state.disposed++ },
    dispose: async () => { state.attached.clear(); state.disposed++ },
    staleAttachments: async () => new Set(state.stale || []),
  }
  const service = new OpenCodeTerminalService(agent, process.cwd(), () => (executable, args, options) => {
    state.spawns.push({ executable, args, options })
    return { write: data => state.writes.push(data), resize: (...size) => state.sizes.push(size), kill: () => { state.killed++ },
      onData: fn => { state.data = fn }, onExit: fn => { state.exit = fn } }
  })
  return { state, runtime, service }
}

test('closing a stopped server waits for its display cleanup and deduplicates repeated close requests', async () => {
  let finish
  const exited = new Promise(resolve => { finish = resolve })
  let released = 0, closes = 0, alive = true
  const agent = { prepareTerminal: async () => ({ executable: 'qa', address: 'http://127.0.0.1:1', directory: process.cwd(), attachment: 1, sessionId: 'qa', remoteSessionId: 'qa' }),
    terminalAttachmentAlive: () => alive, releaseTerminal: async () => { released++ }, dispose: async () => {} }
  const service = new OpenCodeTerminalService(agent, process.cwd(), () => () => ({ write() {}, resize() {}, kill() {}, onData() {}, onExit() {}, close: async () => { closes++; await exited } }))
  const opened = await service.open(input)
  alive = false; assert.equal(service.poll(opened.id, 0).running, false)
  let done = false
  const first = service.close(opened.id).then(() => { done = true })
  const second = service.close(opened.id)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(done, false); assert.equal(released, 0); assert.equal(closes, 1)
  finish(); await Promise.all([first, second]); assert.equal(released, 1)
})
test('native terminal attaches to the guarded server and keeps credentials out of the bridge', async () => {
  const { state, service } = fixture()
  const opened = await service.open(input)
  assert.equal(opened.running, true)
  assert.deepEqual(state.spawns[0].args, ['--server', 'http://127.0.0.1:34567', '--session', 'ses_qa', process.cwd()])
  assert.ok(!state.spawns[0].args.includes('--auto'))
  assert.ok(!JSON.stringify(opened).includes('private-main-password'))
  assert.equal(state.spawns[0].options.env.OPENCODE_PASSWORD, 'private-main-password')
  assert.ok(state.spawns[0].options.env.HOME.startsWith(process.cwd()))
  state.data('\x1b[31m你好\x1b[0m')
  const first = service.poll(opened.id, 0)
  assert.equal(first.data, '\x1b[31m你好\x1b[0m')
  assert.equal(service.poll(opened.id, first.cursor).data, '')
  service.write(opened.id, '\x00\x03你好\r')
  service.resize(opened.id, 120, 40)
  assert.deepEqual(state.writes, ['\x00\x03你好\r'])
  assert.deepEqual(state.sizes, [[120, 40]])
  await service.close(opened.id)
  assert.equal(state.killed, 1)
})
test('boundary validation rejects invalid dimensions, output cursors, terminal IDs and oversized input', async () => {
  const { service } = fixture()
  for (const size of [[0, 24], [80, 0], [501, 24], [80, 251], ['80', 24], [80.5, 24]]) assert.throws(() => terminalSize(...size), /dimensions/)
  await assert.rejects(service.open({ ...input, terminalId: '../bad' }), /terminal ID/)
  const opened = await service.open(input)
  assert.throws(() => service.poll(opened.id, -1), /cursor/)
  assert.throws(() => service.poll(opened.id, 1), /cursor/)
  assert.throws(() => service.write('other', 'x'), /no longer/)
  assert.throws(() => service.write(opened.id, 'x'.repeat(65537)), /input/)
  await assert.rejects(service.open({ ...input, terminalId: opened.id }), /already open/)
  await service.close()
})
test('closing during startup prevents a late PTY launch and stale cleanup cannot close its successor', async () => {
  let release
  const wait = new Promise(resolve => { release = resolve })
  const { state, service, runtime } = fixture(async () => { await wait; return runtime })
  const firstId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  const pending = service.open({ ...input, terminalId: firstId })
  assert.equal(service.poll(firstId, 0).starting, true)
  await service.close(firstId)
  release()
  await assert.rejects(pending, /cancelled/)
  assert.equal(state.spawns.length, 0)
  const next = await service.open(input)
  const disposed = state.disposed
  await service.close(firstId)
  assert.equal(state.disposed, disposed)
  assert.equal(service.poll(next.id, 0).running, true)
  await service.close(next.id)
})

test('a disconnected view can keep observing pending startup without replacing its task', async () => {
  let release
  const wait = new Promise(resolve => { release = resolve })
  const { state, service, runtime } = fixture(async () => { await wait; return runtime })
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const pending = service.open({ ...input, terminalId: id })
  const initial = service.poll(id, 0)
  assert.equal(initial.starting, true)
  assert.equal(initial.running, false)
  assert.equal(initial.sessionId, '')
  assert.throws(() => service.write(id, 'x'), /still starting/)
  const observed = await service.reconnect(id, 100, 30)
  assert.equal(observed.starting, true)
  assert.equal(state.spawns.length, 0)
  assert.equal(state.killed, 0)
  assert.equal(state.disposed, 0)
  release()
  const opened = await pending
  assert.equal(opened.id, id)
  assert.equal(opened.starting, false)
  assert.equal(opened.running, true)
  assert.equal(state.spawns.length, 1)
  await service.close(id)
})

test('failed startup reports an ended attempt instead of leaving a pending snapshot', async () => {
  const { service } = fixture(async () => { throw new Error('Runtime failed to start') })
  const id = 'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff'
  await assert.rejects(service.open({ ...input, terminalId: id }), /Runtime failed/)
  const failed = service.poll(id, 0)
  assert.equal(failed.starting, false)
  assert.equal(failed.running, false)
  assert.match(failed.error, /Runtime failed/)
  await service.close(id)
})
test('a surviving display client is marked ended when its work server has stopped', async () => {
  const { state, service } = fixture()
  const opened = await service.open(input)
  state.data('Last real output')
  state.serverAlive = false
  const ended = service.poll(opened.id, 0)
  assert.equal(ended.running, false)
  assert.equal(ended.canReconnect, false)
  assert.equal(ended.data, 'Last real output')
  assert.match(ended.error, /work service stopped/)
  assert.equal(state.killed, 1)
  state.data('Stale output after close')
  assert.equal(service.poll(opened.id, 0).data, 'Last real output')
  await assert.rejects(service.reconnect(opened.id, 100, 30), /server stopped/)
  assert.equal(state.spawns.length, 1, 'reattach must not create a new server')
  await service.close(opened.id)
  assert.equal(state.killed, 1, 'the orphan client is stopped exactly once')
  assert.equal(state.released.length, 1)
})

test('native display exit retains final output and the running server until the tab closes', async () => {
  const { state, service } = fixture()
  const opened = await service.open(input)
  state.data('Final output'); state.exit({ exitCode: 1 })
  const last = service.poll(opened.id, 0)
  assert.equal(last.running, false)
  assert.equal(last.data, 'Final output')
  assert.match(last.error, /code 1/)
  assert.equal(last.canReconnect, true)
  assert.equal(state.disposed, 0, 'a display client crash must not kill server-side commands')
  assert.deepEqual(state.released, [])
  assert.equal(state.killed, process.platform === 'win32' ? 1 : 0)
  assert.throws(() => service.write(opened.id, 'x'), /exited/)
  await service.close(opened.id)
  assert.equal(state.disposed, 1)
  assert.equal(state.released.length, 1)
})
test('output retention is bounded and a slow reader receives an explicit reset', async () => {
  const { state, service } = fixture()
  const opened = await service.open(input)
  state.data('x'.repeat(3 * 1024 * 1024))
  const next = service.poll(opened.id, 0)
  assert.equal(next.reset, true)
  assert.equal(next.data.length, 2 * 1024 * 1024)
  assert.equal(next.cursor, 3 * 1024 * 1024)
  await service.close()
})
test('several Work tabs share one server, close independently and stop it only after the last one', async () => {
  const { state, service } = fixture()
  const first = await service.open(input)
  const second = await service.open(input)
  assert.notEqual(first.id, second.id)
  assert.equal(state.spawns.length, 2)
  await service.close(first.id)
  assert.equal(state.disposed, 0, 'closing one tab must keep the shared server for the other')
  assert.equal(service.poll(second.id, 0).running, true)
  assert.throws(() => service.poll(first.id, 0), /no longer/)
  await service.close(second.id)
  assert.equal(state.disposed, 1)
  assert.deepEqual(state.released.length, 2)
})
test('a display client exiting keeps its attachment until that tab is closed', async () => {
  const { state, service } = fixture()
  const first = await service.open(input)
  const exitFirst = state.exit
  const second = await service.open(input)
  exitFirst({ exitCode: 0 })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(service.poll(first.id, 0).running, false)
  assert.equal(service.poll(second.id, 0).running, true)
  assert.equal(state.disposed, 0)
  assert.deepEqual(state.released, [])
  await service.close(first.id)
  assert.equal(state.released.length, 1, 'closing the disconnected tab releases only its attachment')
  await service.close()
  assert.equal(state.disposed, 1)
})

test('reconnect reuses a live PTY and then reattaches an exited client to the original server and session', async () => {
  const { state, service } = fixture()
  const opened = await service.open(input)
  state.data('Prior output')
  const firstSpawn = state.spawns[0]
  const reattached = await service.reconnect(opened.id, 120, 40)
  assert.equal(reattached.id, opened.id)
  assert.equal(reattached.sessionId, opened.sessionId)
  assert.equal(reattached.reset, false)
  assert.equal(reattached.data, '', 'a live PTY must not receive responses to replayed device probes')
  assert.equal(reattached.cursor, 'Prior output'.length)
  assert.equal(state.spawns.length, 1, 'display reconnect must not restart a live PTY')
  assert.deepEqual(state.sizes, [[120, 40]])

  const oldData = state.data
  const oldExit = state.exit
  oldExit({ exitCode: 1 })
  const restartedClient = await service.reconnect(opened.id, 110, 35)
  assert.equal(restartedClient.id, opened.id)
  assert.equal(restartedClient.sessionId, opened.sessionId)
  assert.equal(restartedClient.running, true)
  assert.equal(restartedClient.error, '')
  assert.equal(restartedClient.reset, true)
  assert.equal(restartedClient.data, '', 'the replacement client starts with its own screen and device probes')
  assert.equal(restartedClient.cursor, 'Prior output'.length, 'output cursors remain monotonic across client reconnection')
  assert.equal(state.spawns.length, 2)
  assert.deepEqual(state.spawns[1].args, firstSpawn.args, 'the same server address and native session must be reused')
  assert.equal(state.spawns[1].options.env.OPENCODE_PASSWORD, firstSpawn.options.env.OPENCODE_PASSWORD)
  assert.equal(state.nextAttachment, 1, 'reconnect must not prepare a new server/session or reselect its model')
  assert.equal(state.disposed, 0)
  assert.deepEqual(state.released, [])
  oldData('Stale client output'); oldExit({ exitCode: 1 })
  state.data('New output')
  assert.equal(service.poll(opened.id, 0).data, 'New output')
  assert.equal(service.poll(opened.id, 0).cursor, 'Prior outputNew output'.length)
  assert.equal(service.poll(opened.id, 0).running, true, 'late events from the old client must not end its replacement')
  await service.close(opened.id)
  assert.equal(state.disposed, 1)
})

test('reconnect never silently recreates a stopped server or revoked task', async () => {
  const { state, service } = fixture()
  const opened = await service.open(input)
  state.exit({ exitCode: 1 })
  state.serverAlive = false
  assert.equal(service.poll(opened.id, 0).canReconnect, false)
  await assert.rejects(service.reconnect(opened.id, 100, 30), /original OpenCode server stopped/)
  assert.equal(state.spawns.length, 1)
  assert.equal(state.nextAttachment, 1)

  state.serverAlive = true
  state.stale = [state.nextAttachment]
  await assert.rejects(service.reconnect(opened.id, 100, 30), /Folder permissions changed/)
  assert.equal(service.poll(opened.id, 0).canReconnect, false)
  assert.equal(state.disposed, 1, 'access revocation still stops commands when the display is disconnected')
  assert.equal(state.spawns.length, 1)
  await service.close(opened.id)
  assert.equal(state.released.length, 1)
})
test('the number of simultaneous Work tabs is bounded', async () => {
  const { service } = fixture()
  for (let index = 0; index < 8; index += 1) await service.open(input)
  await assert.rejects(service.open(input), /At most 8/)
  await service.close()
})
test('a folder permission change ends only the affected tabs and flags them to reconnect', async () => {
  const { state, service } = fixture()
  const first = await service.open(input)
  const firstAttachment = state.nextAttachment
  const second = await service.open(input)
  state.stale = [firstAttachment]
  await service.refreshAccess()
  const ended = service.poll(first.id, 0)
  assert.equal(ended.running, false)
  assert.equal(ended.accessChanged, true)
  assert.equal(ended.error, '')
  assert.deepEqual(state.released, [firstAttachment])
  assert.equal(service.poll(second.id, 0).running, true)
  assert.equal(service.poll(second.id, 0).accessChanged, undefined)
  assert.throws(() => service.write(first.id, 'x'), /exited/)
  await service.close(first.id)
  assert.deepEqual(state.released, [firstAttachment], 'closing the ended tab must not release twice')
  await service.close()
})
