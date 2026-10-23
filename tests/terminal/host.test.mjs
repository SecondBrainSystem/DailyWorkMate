import test, { before } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdir, mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

let TerminalHost
before(async () => {
  await mkdir('tmp/qa', { recursive: true })
  const output = path.resolve('tmp/qa/terminal-host-tests.mjs')
  await build({ entryPoints: ['src/main/terminal/host.ts'], outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external' })
  ;({ TerminalHost } = await import(pathToFileURL(output).href))
})

const windows = process.platform === 'win32'
const id = n => String(n).repeat(8) + '-1111-1111-1111-111111111111'
const shell = (n, extra = {}) => ({ session: { id: id(n), kind: 'cmd', title: 'CMD', directory: os.tmpdir(), cols: 100, rows: 30, status: 'running', error: '', createdAt: 1 }, output: '', resume: false, ...extra })
const context = { workspaces: [], groups: [], persona: '', executable: '' }
async function home(t, cleanup = async () => {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dailyworkmate-terminal-host-'))
  t.after(async () => { try { await cleanup() } finally { await rm(directory, { recursive: true, force: true }) } })
  return directory
}
// Stands in for node-pty inside the real PTY helper: echoes input and reports `cd <dir>` as cmd's OSC 7 prompt.
const fakePty = `exports.spawn = (file, args, options) => {
  const data = new Set(), exit = new Set()
  const emit = (listeners, value) => setImmediate(() => { for (const listener of listeners) listener(value) })
  emit(data, 'ready>')
  return { pid: 2147483645, resize() {}, kill: () => emit(exit, { exitCode: 0 }),
    write: value => emit(data, value.startsWith('cd ') ? '\\x1b]7;file://localhost/' + value.slice(3).trim() + '\\x07' : value),
    onData: listener => { data.add(listener); return { dispose: () => data.delete(listener) } },
    onExit: listener => { exit.add(listener); return { dispose: () => exit.delete(listener) } } }
}`

test('damaged saved terminals are skipped or set aside, never fatal to the host', async t => {
  const directory = await home(t)
  const file = path.join(directory, 'sessions.json')
  const valid = shell(1)
  await writeFile(file, JSON.stringify({ version: 1, preferences: { restoreOnStartup: true, keepRunningOnExit: true }, activeId: id(1), sessions: [
    valid, shell(2, { session: { ...valid.session, id: '../escape' } }), null, shell(3, { resume: 'yes' }), valid,
    { session: { ...valid.session, id: id(4), kind: 'opencode', opencode: { workspaceId: 'qa', model: 'qa-model' } }, output: '', resume: true },
  ] }))
  const host = new TerminalHost(directory, '', '')
  await host.initialize()
  const state = host.state()
  assert.deepEqual(state.sessions.map(session => [session.id, session.status]), [[id(1), 'exited']], 'invalid, duplicate and legacy OpenCode entries are dropped')
  assert.equal(state.activeId, id(1))
  assert.deepEqual(state.preferences, { restoreOnStartup: true, keepRunningOnExit: false })

  for (const damaged of ['{"version":1,', JSON.stringify({ version: 2, sessions: [] }), JSON.stringify({ version: 1, preferences: null, sessions: [] })]) {
    await writeFile(file, damaged)
    const fresh = new TerminalHost(directory, '', '')
    await fresh.initialize()
    assert.deepEqual(fresh.state().sessions, [])
    const backups = (await readdir(directory)).filter(name => /^sessions\.json\..+\.bak$/.test(name))
    assert.ok((await Promise.all(backups.map(name => readFile(path.join(directory, name), 'utf8')))).includes(damaged), 'the unreadable file is kept for inspection')
    await assert.rejects(readFile(file), { code: 'ENOENT' })
  }
})

test('shells stream output without re-saving, save directory changes, refuse OpenCode and stop together', { skip: !windows && 'CMD terminals require Windows' }, async t => {
  let host
  const directory = await home(t, () => host?.shutdown())
  const module = path.join(directory, 'fake-pty.cjs')
  await writeFile(module, fakePty)
  host = new TerminalHost(directory, path.resolve('scripts/companion-pty-host.cjs'), module)
  await host.initialize(); await host.sync(context)
  await assert.rejects(host.create({ id: id(9), kind: 'opencode', directory: os.tmpdir(), cols: 100, rows: 30, opencode: { workspaceId: 'qa', model: 'qa-model' } }), /Work/)
  const created = await host.create({ id: id(1), kind: 'cmd', directory: os.tmpdir(), cols: 100, rows: 30 })
  assert.equal(created.sessions[0].status, 'running', created.sessions[0].error)
  let saves = 0
  host.scheduleSave = () => { saves++ }
  const until = async (check, label) => { const end = Date.now() + 10000; while (!check()) { if (Date.now() > end) throw new Error('Timed out: ' + label); await new Promise(resolve => setTimeout(resolve, 20)) } }
  host.write(id(1), 'hello')
  await until(() => host.poll(id(1), 0).data.includes('hello'), 'echo')
  assert.equal(saves, 0, 'output alone never schedules a save')
  const { cursor } = host.poll(id(1), 0)
  assert.deepEqual([host.poll(id(1), cursor).data, host.poll(id(1), cursor).reset], ['', false])
  assert.equal(host.poll(id(1), cursor + 1).reset, true)
  const target = path.join(os.tmpdir(), 'dailyworkmate-qa-target')
  host.write(id(1), 'cd ' + target)
  await until(() => host.state().sessions[0].directory === target, 'directory report')
  assert.equal(saves, 1)
  delete host.scheduleSave
  await host.create({ id: id(2), kind: 'cmd', directory: os.tmpdir(), cols: 100, rows: 30 })
  await host.detach()
  assert.deepEqual(host.state().sessions.map(session => session.status), ['exited', 'exited'])
  const saved = JSON.parse(await readFile(path.join(directory, 'sessions.json'), 'utf8'))
  assert.deepEqual(saved.sessions.map(item => item.resume), [true, true], 'stopped on exit, restored on the next start')
  assert.ok(saved.sessions.every(item => item.output === ''), 'output is never written to disk')
})

test('split panes share a tab, keep their layout across a restart and close back to one pane', { skip: !windows && 'CMD terminals require Windows' }, async t => {
  const hosts = []
  const directory = await home(t, async () => { for (const host of hosts) await host.shutdown() })
  const module = path.join(directory, 'fake-pty.cjs')
  await writeFile(module, fakePty)
  const start = async () => { const host = new TerminalHost(directory, path.resolve('scripts/companion-pty-host.cjs'), module); hosts.push(host); await host.initialize(); await host.sync(context); return host }
  const first = await start()
  const shellInput = (n, split) => ({ id: id(n), kind: 'cmd', directory: os.tmpdir(), cols: 100, rows: 30, ...(split ? { split } : {}) })
  await first.create(shellInput(1))
  await first.create(shellInput(2, { beside: id(1), direction: 'row' }))
  let state = await first.create(shellInput(3, { beside: id(2), direction: 'column' }))
  assert.equal(state.tabs.length, 1)
  assert.deepEqual(state.tabs[0], { id: id(1), focused: id(3), layout: { split: 'row', ratio: 0.5, first: { pane: id(1) }, second: { split: 'column', ratio: 0.5, first: { pane: id(2) }, second: { pane: id(3) } } } })
  await assert.rejects(first.create(shellInput(5, { beside: id(9), direction: 'row' })), /closed/)
  await first.create(shellInput(4, { beside: id(1), direction: 'column' }))
  await assert.rejects(first.create(shellInput(5, { beside: id(1), direction: 'row' })), /At most 4 panes/)
  state = await first.select(id(2))
  assert.equal(state.tabs[0].focused, id(2))
  assert.throws(() => first.saveLayout(id(1), { pane: id(1) }), /panes changed/)
  state = first.saveLayout(id(1), { ...state.tabs[0].layout, ratio: 0.99 })
  assert.equal(state.tabs[0].layout.ratio, 0.85, 'ratios are clamped')
  state = await first.close(id(4))
  assert.deepEqual(panesOfState(state), [id(1), id(2), id(3)])
  await first.detach()

  const second = await start()
  state = second.state()
  assert.deepEqual(state.tabs[0], { id: id(1), focused: id(2), layout: { split: 'row', ratio: 0.85, first: { pane: id(1) }, second: { split: 'column', ratio: 0.5, first: { pane: id(2) }, second: { pane: id(3) } } } })
  assert.equal(state.activeId, id(2))
  state = await second.close(id(2))
  assert.equal(state.activeId, id(3), 'the sibling takes over focus')
  state = await second.close(id(3)); state = await second.close(id(1))
  assert.deepEqual([state.tabs, state.activeId], [[], ''], 'closing the last pane closes the tab')
})
const panesOfState = state => JSON.stringify(state.tabs[0].layout).match(/[0-9]{8}-1111-1111-1111-111111111111/g)

test('six saved tabs start only on selection, share concurrent startups, and cannot start after close or exit', { skip: !windows && 'CMD terminals require Windows' }, async t => {
  let host
  const directory = await home(t, () => host?.shutdown())
  const module = path.join(directory, 'fake-pty.cjs')
  const spawnLog = path.join(directory, 'spawns.txt')
  await writeFile(spawnLog, '')
  await writeFile(module, fakePty.replace("  const data =", "  require('node:fs').appendFileSync(require('node:path').join(options.cwd, 'spawns.txt'), 'spawn\\n')\n  const data ="))
  const sessions = Array.from({ length: 6 }, (_, index) => {
    const item = shell(index + 1)
    return { ...item, session: { ...item.session, directory }, resume: index !== 3 }
  })
  await writeFile(path.join(directory, 'sessions.json'), JSON.stringify({ version: 1, preferences: { restoreOnStartup: true, keepRunningOnExit: false }, activeId: id(1), sessions }))
  host = new TerminalHost(directory, path.resolve('scripts/companion-pty-host.cjs'), module)
  await host.initialize()
  assert.ok(host.state().sessions.every(session => session.status === 'exited'))
  await host.sync(context)
  assert.deepEqual(host.state().sessions.filter(session => session.status === 'running').map(session => session.id), [id(1)])
  assert.equal(host.state().tabs.length, 6, 'all tabs remain available without spawning all shells')
  const selecting = Promise.all([host.select(id(2)), host.select(id(2)), host.select(id(2))])
  host.resize(id(2), 120, 40)
  await selecting
  assert.equal(host.state().sessions.find(session => session.id === id(2)).status, 'running')
  assert.equal(host.state().sessions.find(session => session.id === id(2)).cols, 120)
  const deadline = Date.now() + 10000
  while ((await readFile(spawnLog, 'utf8')).split('\n').filter(Boolean).length < 2) {
    assert.ok(Date.now() < deadline, 'helpers must start')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  await host.select(id(4))
  assert.equal(host.state().sessions.find(session => session.id === id(4)).status, 'exited', 'a naturally exited shell stays exited')
  const closing = host.select(id(5))
  await host.close(id(5)); await closing
  assert.ok(!host.state().sessions.some(session => session.id === id(5)), 'closing cancels a pending startup')
  await host.close(id(1)); await host.close(id(2))
  assert.equal(host.state().activeId, id(3))
  assert.equal(host.state().sessions.find(session => session.id === id(3)).status, 'running', 'closing the active tab starts the newly visible tab')
  const quitting = host.select(id(6))
  await host.detach(); await quitting
  assert.ok(host.state().sessions.every(session => session.status === 'exited'))
  const saved = JSON.parse(await readFile(path.join(directory, 'sessions.json'), 'utf8'))
  assert.deepEqual(saved.sessions.map(item => [item.session.id, item.resume]), [[id(3), true], [id(4), false], [id(6), true]], 'deferred tabs survive exit and can resume later')
  // Tab 3 can be stopped before its helper reports startup; tabs 1 and 2 must each have spawned exactly once.
  const spawns = (await readFile(spawnLog, 'utf8')).split('\n').filter(Boolean).length
  assert.ok(spawns >= 2 && spawns <= 3, 'rapid selection and cancellation must not launch duplicate or closed shells: ' + spawns)
})
