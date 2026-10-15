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
  const state = { spawns: [], writes: [], sizes: [], killed: 0, disposed: 0, released: [], attached: new Set(), nextAttachment: 0 }
  const runtime = { executable: 'opencode.exe', address: 'http://127.0.0.1:34567', password: 'private-main-password', directory: process.cwd(), remoteSessionId: 'ses_qa', sessionId: 'v2:qa:ses_qa' }
  // Mirrors OpenCodeService: every prepared client holds a token and the last release stops the server.
  const attach = value => { const attachment = ++state.nextAttachment; state.attached.add(attachment); return { ...value, attachment } }
  const agent = {
    prepareTerminal: async terminalInput => attach(prepare ? await prepare(terminalInput) : runtime),
    releaseTerminal: async attachment => { state.released.push(attachment); if (state.attached.delete(attachment) && state.attached.size === 0) state.disposed++ },
    dispose: async () => { state.attached.clear(); state.disposed++ },
    staleAttachments: async () => new Set(state.stale || []),
  }
  const pty = { write: data => state.writes.push(data), resize: (...size) => state.sizes.push(size), kill: () => { state.killed++ },
    onData: fn => { state.data = fn }, onExit: fn => { state.exit = fn } }
  const service = new OpenCodeTerminalService(agent, process.cwd(), () => (executable, args, options) => {
    state.spawns.push({ executable, args, options }); return pty
  })
  return { state, runtime, service }
}
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
test('native exit retains final output, releases the server and rejects further input', async () => {
  const { state, service } = fixture()
  const opened = await service.open(input)
  state.data('Final output'); state.exit({ exitCode: 1 })
  const last = service.poll(opened.id, 0)
  assert.equal(last.running, false)
  assert.equal(last.data, 'Final output')
  assert.match(last.error, /code 1/)
  assert.equal(state.disposed, 1)
  assert.equal(state.killed, process.platform === 'win32' ? 1 : 0)
  assert.throws(() => service.write(opened.id, 'x'), /exited/)
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
test('a tab exiting on its own releases only its own attachment', async () => {
  const { state, service } = fixture()
  const first = await service.open(input)
  const exitFirst = state.exit
  const second = await service.open(input)
  exitFirst({ exitCode: 0 })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(service.poll(first.id, 0).running, false)
  assert.equal(service.poll(second.id, 0).running, true)
  assert.equal(state.disposed, 0)
  await service.close(first.id)
  assert.equal(state.released.length, 1, 'a closed tab that already exited must not release twice')
  await service.close()
  assert.equal(state.disposed, 1)
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
