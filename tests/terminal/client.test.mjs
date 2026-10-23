import test, { before } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile, rm, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

let TerminalClient
before(async () => {
  await mkdir('tmp/qa', { recursive: true })
  const output = path.resolve('tmp/qa/terminal-client-tests.mjs')
  await build({ entryPoints: ['src/main/terminal/client.ts'], outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external' })
  ;({ TerminalClient } = await import(pathToFileURL(output).href))
})

const token = 'f'.repeat(64)
const state = { defaultDirectory: 'C:\\', preferences: { restoreOnStartup: true, keepRunningOnExit: false }, sessions: [], activeId: '', shells: [] }
/** A stand-in terminal host speaking the host's HTTP protocol; `handle` may hang or drop a request. */
async function fakeHost(t, handle = () => undefined) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dailyworkmate-terminal-client-'))
  const actions = [], sockets = new Set()
  const server = createServer(async (request, response) => {
    if (request.url === '/lease') { response.writeHead(200); response.write('attached\n'); return }
    let raw = ''
    for await (const chunk of request) raw += chunk
    const value = JSON.parse(raw)
    actions.push(value.action)
    const custom = await handle(value, request, response)
    if (custom === 'handled') return
    const result = value.action === 'ping' ? { protocol: 1 } : value.action === 'detach' ? false : state
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ result }))
    if (value.action === 'detach') await unlink(path.join(home, 'host.json'))
  })
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  await writeFile(path.join(home, 'host.json'), JSON.stringify({ protocol: 1, port: server.address().port, token, pid: 4242 }))
  const stop = () => { for (const socket of sockets) socket.destroy(); server.close() }
  t.after(async () => { stop(); await rm(home, { recursive: true, force: true }) })
  return { home, actions, stop }
}
const client = (home, options = {}) => new TerminalClient({ home, entry: path.join(home, 'missing-entry.js'), helper: '', ptyModule: '', alive: () => true, context: async () => ({ workspaces: [], groups: [], persona: '', executable: '' }), ...options })

test('periodic refresh reads state; the host is synced on connect and when folders change, never with models', async t => {
  const host = await fakeHost(t)
  const requested = []
  let context = { workspaces: [], groups: [], persona: '', executable: '' }
  const manager = client(host.home, { context: async models => { requested.push(models); return context } })
  await manager.refresh()
  assert.deepEqual(host.actions, ['ping', 'sync'], 'the first refresh does not repeat the sync done while connecting')
  await manager.refresh(); await manager.refresh()
  assert.deepEqual(host.actions.slice(2), ['state', 'state'])
  context = { ...context, workspaces: [{ id: 'qa', name: 'QA', path: 'C:\\QA', writable: true }] }
  await manager.refresh()
  assert.equal(host.actions.at(-1), 'sync')
  await manager.synchronize()
  assert.equal(host.actions.at(-1), 'sync', 'explicit synchronization always pushes the context')
  await manager.synchronizeIfConnected()
  assert.equal(host.actions.at(-1), 'sync', 'folder edits reach a connected host')
  assert.ok(requested.every(models => models.length === 0), 'model connections are never resolved for the terminal host')
  await manager.detach()
  assert.deepEqual(host.actions.slice(-3), ['state', 'preferences', 'detach'])
})

test('saved terminals and folder edits do not start a host before the Terminal view is opened', async t => {
  const host = await fakeHost(t)
  await unlink(path.join(host.home, 'host.json'))
  const file = path.join(host.home, 'sessions.json')
  const saved = JSON.stringify({ version: 1, preferences: { restoreOnStartup: true, keepRunningOnExit: false }, sessions: Array.from({ length: 6 }, (_, id) => ({ session: { id }, resume: true })) })
  await writeFile(file, saved)
  const manager = client(host.home)
  assert.equal(await manager.neededAtStartup(), false)
  await manager.synchronizeIfConnected()
  await manager.detach()
  assert.deepEqual(host.actions, [], 'no host command or shell startup is needed')
  assert.equal(await readFile(file, 'utf8'), saved, 'deferred restoration preserves the saved tabs')

  const running = await fakeHost(t)
  const attached = client(running.home)
  assert.equal(await attached.neededAtStartup(), true, 'an existing host is still rejoined')
  await attached.synchronizeIfConnected()
  assert.ok(running.actions.includes('sync'))
  await attached.detach()
})

test('a live host that does not answer is never replaced by a second host', async t => {
  const host = await fakeHost(t, () => 'handled')
  const manager = client(host.home, { busyHostWait: 1600 })
  await assert.rejects(manager.refresh(), /not responding/)
  assert.ok(host.actions.length >= 2 && host.actions.every(action => action === 'ping'), 'pings were retried')
})

test('a host whose process is gone, or whose port is closed, may be replaced', async t => {
  const hung = await fakeHost(t, () => 'handled')
  assert.equal(await client(hung.home, { alive: () => false }).attachExisting(), false)
  const closed = await fakeHost(t)
  closed.stop()
  assert.equal(await client(closed.home).attachExisting(), false)
})

test('quitting is not blocked by a host that already stopped or by a failed connection', async t => {
  assert.equal(await client(path.join(os.tmpdir(), 'dailyworkmate-no-host')).detach(), undefined, 'nothing to stop')

  const crashed = await fakeHost(t)
  const first = client(crashed.home, { alive: () => false })
  await first.refresh(); crashed.stop()
  await first.detach()

  let drop = false
  const reset = await fakeHost(t, (value, request) => { if (drop && value.action === 'state') { request.socket.destroy(); return 'handled' } })
  const alive = { value: false }
  const second = client(reset.home, { alive: () => alive.value })
  await second.refresh(); drop = true
  await second.detach()
  assert.equal(reset.actions.at(-1), 'state', 'a connection reset from a process that is gone counts as stopped')

  const third = client(reset.home, { alive: () => alive.value })
  drop = false; await third.refresh(); drop = true; alive.value = true
  await assert.rejects(third.detach(), /socket hang up|ECONNRESET/, 'a reset from a host that is still running is reported')

  const hung = await fakeHost(t, () => 'handled')
  const fourth = client(hung.home, { busyHostWait: 200 })
  const connecting = fourth.refresh()
  await fourth.detach()
  await assert.rejects(connecting, /not responding/)
})
