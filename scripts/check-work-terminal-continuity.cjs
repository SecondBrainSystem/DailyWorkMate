// Real renderer + Work terminal service + native PTY. A deterministic long-running
// child writes its PID and heartbeat to disk, so a restored screen cannot mask a restart.
// Run with: .\node_modules\electron\dist\electron.exe scripts/check-work-terminal-continuity.cjs
// Add --reconnect to exercise native-client exit and a server-death race during reattachment.
// Add --lost-open-ack or --lost-starting-ack to exercise lost startup IPC responses.
const { app, BrowserWindow, ipcMain } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
fs.mkdirSync(path.join(root, 'tmp'), { recursive: true })
const scratch = fs.mkdtempSync(path.join(root, 'tmp', 'work-terminal-continuity-'))
const ledger = path.join(scratch, 'heartbeats.jsonl')
const nodeExecutable = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['node'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)[0]
app.setPath('userData', path.join(scratch, 'profile'))
app.disableHardwareAcceleration()
// Closing the hidden window during cleanup must not replace a failure exit code.
app.on('window-all-closed', () => {})

buildSync({ stdin: { contents: "export { OpenCodeTerminalService } from './src/main/companion/terminal.ts'; export { terminalSpawner } from './src/main/companion/terminalProcess.ts'; export { shouldCloseWorkTerminalsForNavigation } from './src/main/companion/terminalLifecycle.ts';", resolveDir: root },
  outfile: path.join(scratch, 'service.cjs'), bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
const { OpenCodeTerminalService, terminalSpawner, shouldCloseWorkTerminalsForNavigation } = require(path.join(scratch, 'service.cjs'))
const legacyNavigation = process.argv.includes('--legacy-navigation')
const reconnectMode = process.argv.includes('--reconnect')
const restartMode = process.argv.includes('--restart')
const prepareFailure = process.argv.includes('--prepare-failure')
const lostOpenAck = process.argv.includes('--lost-open-ack')
const lostStartingAck = process.argv.includes('--lost-starting-ack')
let loseNextOpenAck = lostOpenAck || lostStartingAck
let finishPreparation
const preparationReady = lostStartingAck ? new Promise(resolve => { finishPreparation = resolve }) : Promise.resolve()

const rendererSource = `
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import './src/renderer/src/i18n'
import { OpenCodeTerminal } from './src/renderer/src/components/companion/OpenCodeTerminal'
let preparations = 0
function Harness() {
  const [hidden, setHidden] = useState(false)
  const [chinese, setChinese] = useState(false)
  const [screenReaderMode, setScreenReaderMode] = useState(false)
  const [mounted, setMounted] = useState(true)
  const [sessionId, setSessionId] = useState('')
  return <><nav>
    <button id="visibility" onClick={() => setHidden(value => !value)}>Visibility</button>
    <button id="language" onClick={() => setChinese(value => !value)}>Language</button>
    <button id="accessibility" onClick={() => setScreenReaderMode(value => !value)}>Accessibility</button>
    <button id="close" onClick={() => setMounted(false)}>Close tab</button>
  </nav>{mounted && <OpenCodeTerminal
    input={{ workspaceId: 'qa-folder', groupId: '', accessScope: 'group', relativePath: '', model: 'qa-model', sessionId }}
    hidden={hidden} chinese={chinese} screenReaderMode={screenReaderMode}
    prepare={async () => { if (${prepareFailure} && preparations++ === 0) throw new Error('QA_INITIAL_MODEL_CHECK_FAILED') }} onSession={setSessionId} />}</>
}
createRoot(document.getElementById('root')).render(<Harness />)
`
buildSync({ stdin: { contents: rendererSource, resolveDir: root, loader: 'tsx' }, outfile: path.join(scratch, 'renderer.js'),
  bundle: true, platform: 'browser', format: 'iife', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' },
  alias: { '@': path.join(root, 'src/renderer/src'), '@shared': path.join(root, 'src/shared') } })
fs.writeFileSync(path.join(scratch, 'index.html'), `<!doctype html><meta charset="utf-8"><style>
${fs.readFileSync(path.join(root, 'node_modules/@xterm/xterm/css/xterm.css'), 'utf8')}
body { margin: 0; background: #fff; } nav { height: 36px; } .companion-terminal-host { width: 1000px; height: 560px; }
</style><div id="root"></div><script src="renderer.js"></script>`)
fs.writeFileSync(path.join(scratch, 'preload.cjs'), `const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('electronAPI', { companion: Object.fromEntries(
  ['openTerminal', 'reconnectTerminal', 'pollTerminal', 'writeTerminal', 'resizeTerminal', 'closeTerminal'].map(name => [name, (...args) => ipcRenderer.invoke('continuity:' + name, ...args)])
) })`)
fs.writeFileSync(path.join(scratch, 'heartbeat.cjs'), `const fs = require('node:fs')
const ledger = process.argv[2]
const launch = process.argv[3]
let sequence = 0
const tick = () => {
  const event = { pid: process.pid, launch, sequence: sequence++, time: Date.now() }
  fs.appendFileSync(ledger, JSON.stringify(event) + '\\n')
  process.stdout.write('HEARTBEAT ' + event.sequence + ' PID ' + event.pid + '\\r\\n')
}
tick(); setInterval(tick, 100)
setTimeout(() => process.exit(2), 120000).unref()
`)

const launched = [], opened = [], closed = [], released = [], rendererErrors = [], checks = [], navigationEvents = []
const prepared = [], nativeClients = [], reattached = [], openAttempts = []
let activeAttachments = new Set()
let releasing = false
let window, service, rejectedPolls = 0, failPolls = 0, navigationClosures = 0
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const js = code => window.webContents.executeJavaScript(code, true)
const beats = () => {
  if (!fs.existsSync(ledger)) return []
  const content = fs.readFileSync(ledger, 'utf8')
  return content.slice(0, content.lastIndexOf('\n')).split('\n').filter(Boolean).map(line => JSON.parse(line))
}
async function waitFor(predicate, label, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out: ' + label)
    await sleep(50)
  }
}
async function click(id) { await js(`document.getElementById(${JSON.stringify(id)}).click()`); await sleep(200) }
async function clickTerminalAction(label) {
  const selector = `[...document.querySelectorAll('.companion-terminal-toolbar button')].find(button => button.textContent.trim() === ${JSON.stringify(label)} && !button.disabled)`
  await waitFor(() => js(`!!(${selector})`), 'terminal action ' + label)
  await js(`(${selector}).click()`)
  await sleep(200)
}
async function continued(label, action) {
  const prior = beats().at(-1)
  const opens = opened.length, closes = closed.length
  await action()
  await waitFor(() => beats().filter(beat => beat.pid === prior.pid && beat.sequence > prior.sequence).length >= 3, label + ' heartbeat')
  const after = beats().at(-1)
  assert.equal(after.pid, prior.pid, label + ': the application PID must stay the same')
  assert.equal(after.launch, prior.launch, label + ': the native process must not be replaced')
  assert.equal(opened.length, opens, label + ': must not open a replacement terminal')
  assert.equal(closed.length, closes, label + ': must not close the active terminal')
  assert.equal(service.poll(opened[0].id, 0).running, true, label + ': original native terminal remains alive')
  checks.push(label)
}

app.whenReady().then(async () => {
  for (const directory of ['home', 'tmp', 'config', 'cache', 'data', 'state']) fs.mkdirSync(path.join(scratch, 'data', 'opencode-v2', directory), { recursive: true })
  const agent = {
    prepareTerminal: async input => {
      assert.equal(releasing, false, 'new preparation must wait for the previous attachment to finish closing')
      const runtime = { executable: 'heartbeat', address: 'http://127.0.0.1:1', password: 'qa', directory: scratch,
        remoteSessionId: input.terminalId, sessionId: input.sessionId || 'qa-session', attachment: prepared.length + 1 }
      prepared.push(runtime)
      activeAttachments = new Set([...activeAttachments, runtime.attachment])
      if (prepared.length === 1) await preparationReady
      return runtime
    },
    releaseTerminal: async attachment => { releasing = true; if (restartMode) await sleep(750); released.push(attachment); activeAttachments = new Set([...activeAttachments].filter(value => value !== attachment)); releasing = false },
    terminalAttachmentAlive: attachment => activeAttachments.has(attachment),
    dispose: async () => { activeAttachments = new Set() },
  }
  const nativeSpawn = terminalSpawner(path.join(root, 'scripts/companion-pty-host.cjs'), path.join(root, 'node_modules/node-pty'))
  service = new OpenCodeTerminalService(agent, scratch, () => (_executable, args, options) => {
    const launch = args[args.indexOf('--session') + 1]
    launched.push(launch)
    const client = nativeSpawn(nodeExecutable, [path.join(scratch, 'heartbeat.cjs'), ledger, launch], options)
    nativeClients.push(client)
    return client
  })
  const operations = {
    openTerminal: async input => {
      openAttempts.push(input.terminalId)
      const pending = service.open(input).then(next => { opened.push(next); return next })
      if (loseNextOpenAck && lostStartingAck) {
        loseNextOpenAck = false
        void pending.catch(error => rendererErrors.push('Detached startup failed: ' + error.message))
        throw new Error('QA_LOST_OPEN_ACK_WHILE_STARTING')
      }
      const next = await pending
      if (loseNextOpenAck) { loseNextOpenAck = false; throw new Error('QA_LOST_OPEN_ACK_AFTER_START') }
      return next
    },
    reconnectTerminal: async (id, cols, rows) => { reattached.push(id); return service.reconnect(id, cols, rows) },
    pollTerminal: (id, cursor) => { if (failPolls > 0) { failPolls--; rejectedPolls++; throw new Error('QA_TRANSIENT_IPC_OUTAGE') } return service.poll(id, cursor) },
    writeTerminal: (id, data) => service.write(id, data),
    resizeTerminal: (id, cols, rows) => service.resize(id, cols, rows),
    closeTerminal: async id => { closed.push(id); await service.close(id) },
  }
  for (const [name, operation] of Object.entries(operations)) ipcMain.handle('continuity:' + name, (_event, ...args) => operation(...args))
  window = new BrowserWindow({ show: false, width: 1100, height: 750, webPreferences: { offscreen: true, backgroundThrottling: false,
    preload: path.join(scratch, 'preload.cjs'), contextIsolation: true, nodeIntegration: false } })
  window.webContents.on('console-message', (_event, level, message) => { if (level === 3) rendererErrors.push(message) })
  await window.loadFile(path.join(scratch, 'index.html'))
  if (prepareFailure) {
    await waitFor(() => js(`document.querySelector('.companion-terminal-state')?.dataset.phase === 'error'`), 'preparation failure shown')
    assert.equal(openAttempts.length, 0)
    await clickTerminalAction('Start terminal again')
    await waitFor(() => js(`document.querySelector('.companion-terminal-state')?.dataset.phase === 'running'`), 'failed preparation retried')
    assert.equal(openAttempts.length, 1)
    checks.push('failed model preparation can be retried even when no terminal was created')
    // The cancelled request had no process or attachment.
    closed.length = 0
  }
  if (lostOpenAck || lostStartingAck) {
    await waitFor(() => js(`document.querySelector('.companion-terminal-state')?.dataset.phase === 'error' && !!document.querySelector('.companion-terminal-toolbar button')`), 'lost startup acknowledgement reported')
    const requestId = openAttempts[0]
    assert.equal(prepared.length, 1)
    if (lostOpenAck) await waitFor(() => beats().length >= 4, 'application remains alive despite lost startup acknowledgement')
    const firstPid = beats()[0]?.pid
    await js(`document.querySelector('.companion-terminal-toolbar button').click()`)
    if (lostStartingAck) {
      await waitFor(() => js(`document.querySelector('.companion-terminal-state')?.dataset.phase === 'starting'`), 'same pending terminal observed')
      await sleep(250)
      assert.deepEqual(openAttempts, [requestId], 'retry must not duplicate a still-starting terminal request')
      assert.deepEqual(closed, [], 'retry must not cancel the original pending startup')
      finishPreparation()
    }
    await waitFor(() => js(`document.querySelector('.companion-terminal-state')?.dataset.phase === 'running'`), 'original terminal recovered from its known request ID')
    await waitFor(() => beats().length >= 7, 'original terminal heartbeat continues after acknowledgement recovery')
    assert.deepEqual(openAttempts, [requestId])
    assert.equal(opened.length, 1)
    assert.equal(opened[0].id, requestId)
    assert.equal(prepared.length, 1)
    assert.equal(launched.length, 1)
    assert.deepEqual(closed, [])
    assert.deepEqual(released, [])
    assert.deepEqual(reattached, [], 'the original native client needs no relaunch')
    if (firstPid) assert.equal(beats().at(-1).pid, firstPid)
    checks.push(lostStartingAck ? 'lost startup acknowledgement recovers the same pending terminal without cancelling its preparation'
      : 'lost open acknowledgement recovers the original live terminal PID without reopening or closing it')
    await click('close')
    await waitFor(() => released.length === 1 && closed.length === 1, 'explicit close after acknowledgement recovery')
    assert.deepEqual(rendererErrors, [])
    fs.writeFileSync(path.join(scratch, 'report.json'), JSON.stringify({ passed: true, checks, pid: beats()[0].pid, requestId,
      prepared: prepared.length, opens: opened.length, closes: closed.length, launches: launched.length, openAttempts }, null, 2))
    console.log('PASS: lost startup acknowledgement recovers the original terminal request without replacing its process')
    return
  }
  await waitFor(() => js(`document.querySelector('.companion-terminal-state')?.dataset.phase === 'running'`), 'native terminal connected')
  await waitFor(() => beats().length >= 4, 'native application heartbeat')

  if (restartMode) {
    const previousPid = beats()[0].pid
    activeAttachments = new Set()
    await waitFor(() => js(`document.querySelector('.companion-terminal-toolbar button')?.textContent.includes('Start terminal again')`), 'dead server with surviving client offers restart')
    await clickTerminalAction('Start terminal again')
    assert.equal(await js(`document.querySelector('.companion-terminal-toolbar button')?.disabled && document.querySelector('.companion-terminal-toolbar button').textContent.includes('Restarting')`), true)
    assert.equal(openAttempts.length, 1, 'restart waits for the previous attachment release')
    await waitFor(() => opened.length === 2, 'replacement terminal opens')
    await waitFor(() => beats().at(-1)?.pid !== previousPid, 'new native process responds')
    assert.equal(prepared.length, 2)
    assert.deepEqual(released, [prepared[0].attachment])
    assert.equal(closed.length, 1)
    assert.deepEqual(rendererErrors, [])
    checks.push('server-death restart waits for delayed release, shows progress and starts a responsive replacement')
    fs.writeFileSync(path.join(scratch, 'report.json'), JSON.stringify({ passed: true, checks, previousPid, replacementPid: beats().at(-1).pid }, null, 2))
    console.log('PASS: dead-server restart waits for cleanup and replaces the native process')
    return
  }

  if (reconnectMode) {
    const first = opened[0]
    const firstPid = beats()[0].pid
    nativeClients[0].kill()
    await waitFor(() => js(`document.querySelector('.companion-terminal-state')?.dataset.phase === 'disconnected'`), 'retained server with disconnected native client')
    assert.equal(service.poll(first.id, 0).running, false)
    assert.equal(service.poll(first.id, 0).canReconnect, true)
    assert.equal(released.length, 0, 'a native display client exiting must not release its server attachment')
    await clickTerminalAction('Reattach terminal')
    await waitFor(() => js(`document.querySelector('.companion-terminal-state')?.dataset.phase === 'running'`), 'same terminal reattached')
    await waitFor(() => beats().at(-1)?.pid !== firstPid, 'replacement display client heartbeat')
    assert.equal(prepared.length, 1, 'reattaching must reuse the original server preparation')
    assert.equal(opened.length, 1, 'reattaching must reuse the original terminal entry')
    assert.equal(closed.length, 0, 'reattaching must not close the existing terminal')
    assert.deepEqual(released, [], 'reattaching retains the original server attachment')
    assert.deepEqual(reattached, [first.id])
    assert.equal(service.poll(first.id, 0).sessionId, first.sessionId)
    assert.equal(launched.length, 2, 'only the disconnected display client is relaunched')
    checks.push('native display-client exit reattaches to the same terminal, session and server attachment')

    nativeClients[1].kill()
    await waitFor(() => js(`document.querySelector('.companion-terminal-state')?.dataset.phase === 'disconnected'`), 'second native client disconnected')
    assert.ok(await js(`document.querySelector('.companion-terminal-toolbar button')?.textContent.includes('Reattach terminal')`))
    activeAttachments = new Set()
    await clickTerminalAction('Reattach terminal')
    await waitFor(() => js(`document.querySelector('.companion-terminal-toolbar button')?.textContent.includes('Start terminal again')`), 'stale reattach becomes explicit start')
    await sleep(350)
    assert.equal(prepared.length, 1, 'a stale Reattach action must not silently prepare a replacement server')
    assert.equal(opened.length, 1, 'a stale Reattach action must not silently open a new terminal')
    assert.equal(launched.length, 2, 'a stale Reattach action must not silently launch a new display')
    assert.deepEqual(closed, [], 'the stale view updates before a replacement is explicitly requested')
    assert.deepEqual(released, [])
    checks.push('server death before a Reattach click does not silently start a replacement task')

    await clickTerminalAction('Start terminal again')
    await waitFor(() => opened.length === 2 && js(`document.querySelector('.companion-terminal-state')?.dataset.phase === 'running'`), 'explicitly started new terminal')
    assert.equal(prepared.length, 2)
    assert.equal(launched.length, 3)
    assert.notEqual(opened[1].id, first.id)
    assert.equal(opened[1].sessionId, first.sessionId, 'history can be retained while the process is explicitly replaced')
    assert.deepEqual(released, [prepared[0].attachment])
    assert.deepEqual(closed, [first.id])
    checks.push('only a second explicit Start action creates a new terminal process')
    await click('close')
    await waitFor(() => released.length === 2 && closed.length === 2, 'final tab close releases the replacement attachment')
    assert.deepEqual(rendererErrors, [])
    fs.writeFileSync(path.join(scratch, 'report.json'), JSON.stringify({ passed: true, checks, prepared: prepared.length, opens: opened.length,
      closes: closed.length, launches: launched.length, reattached, released, firstTerminalId: first.id, replacementTerminalId: opened[1].id }, null, 2))
    console.log('PASS: native display reattaches to the same terminal/session/server; stale Reattach requires a separate explicit Start action')
    return
  }

  // Same event and predicate as production companion IPC registration. The optional
  // legacy flag proves the old `if (isMainFrame)` handler killed tasks on hash routing.
  window.webContents.on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => {
    navigationEvents.push({ url, isInPlace, isMainFrame })
    if (legacyNavigation ? isMainFrame : shouldCloseWorkTerminalsForNavigation(isInPlace, isMainFrame)) {
      navigationClosures++
      void service.close()
    }
  })
  await continued('in-page app navigation preserves the running application', async () => {
    await js(`location.hash = '#/settings'; void 0`)
    await waitFor(() => navigationEvents.length > 0, 'Electron hash navigation event')
    assert.equal(navigationEvents.at(-1).isInPlace, true, 'hash routing is an in-place navigation')
    assert.equal(navigationEvents.at(-1).isMainFrame, true, 'hash routing is a main-frame navigation')
    if (legacyNavigation && navigationClosures) {
      await sleep(400)
      const stoppedCount = beats().length
      await sleep(400)
      assert.equal(beats().length, stoppedCount, 'the old navigation handler stops the actual running application')
    }
    assert.equal(navigationClosures, 0, 'same-page routing must not close native Work terminals')
    await js(`location.hash = '#/companion'; void 0`)
  })

  await continued('multiple failed polls preserve the running application', async () => {
    failPolls = 2
    await waitFor(() => js(`document.querySelector('.companion-terminal-state')?.dataset.phase === 'recovering'`), 'outage displayed')
    const before = beats().at(-1)
    await waitFor(() => rejectedPolls === 2, 'second failed poll')
    assert.ok(beats().at(-1).sequence > before.sequence, 'the actual application continues while the UI is disconnected')
    await waitFor(() => js(`document.querySelector('.companion-terminal-state')?.dataset.phase === 'running'`), 'same terminal recovered')
  })
  await continued('switching away and back preserves the running application', async () => { await click('visibility'); await sleep(400); await click('visibility') })
  await continued('language changes preserve the running application', async () => { await click('language'); await click('language') })
  await continued('accessibility changes preserve the running application', async () => { await click('accessibility'); await click('accessibility') })

  const events = beats()
  assert.equal(new Set(events.map(beat => beat.pid)).size, 1, 'one actual application PID throughout the test')
  for (let index = 1; index < events.length; index++) assert.equal(events[index].sequence, events[index - 1].sequence + 1)
  await click('close')
  await waitFor(() => closed.length === 1 && released.length === 1, 'explicit close releases the native terminal')
  await sleep(400)
  const finalCount = beats().length
  await sleep(400)
  assert.equal(beats().length, finalCount, 'explicitly closing the tab stops the application')
  checks.push('explicit tab closure stops the application')
  assert.deepEqual(rendererErrors, [])
  fs.writeFileSync(path.join(scratch, 'report.json'), JSON.stringify({ passed: true, checks, pid: events[0].pid,
    heartbeatCount: events.length, rejectedPolls, opens: opened.length, closes: closed.length, launches: launched.length, navigationEvents }, null, 2))
  console.log('PASS: original native application PID and uninterrupted heartbeat survive IPC outage, navigation, language and accessibility changes; explicit close stops it')
}).catch(error => {
  console.error(error)
  fs.writeFileSync(path.join(scratch, 'failure.json'), JSON.stringify({ error: error.message, checks, launched, opened, closed, released, prepared, reattached, openAttempts, rendererErrors, navigationEvents, navigationClosures }, null, 2))
  process.exitCode = 1
}).finally(async () => {
  finishPreparation?.()
  await service?.close()
  window?.destroy()
  console.log('QA artifacts: ' + scratch)
  // Let native PTY helpers consume their explicit close before ending the test host.
  await sleep(300)
  app.exit(process.exitCode || 0)
})
