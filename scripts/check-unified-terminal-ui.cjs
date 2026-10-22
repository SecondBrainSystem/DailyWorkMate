// Hidden Electron UI with the real detached terminal host and isolated application profile.
const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const http = require('node:http')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..')
const packagedArgument = process.argv.find(arg => arg.startsWith('--packaged='))
const packaged = packagedArgument ? path.resolve(packagedArgument.slice('--packaged='.length)) : null
const scratch = fs.mkdtempSync(path.join(root, 'tmp', 'unified-terminal-ui-'))
const workspace = path.join(scratch, 'workspace')
fs.mkdirSync(path.join(workspace, 'api-sub'), { recursive: true })
app.setPath('userData', path.join(scratch, 'profile')); app.disableHardwareAcceleration()
buildSync({ entryPoints: [path.join(root, 'src/main/terminal/client.ts')], outfile: path.join(scratch, 'client.cjs'), bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
const { TerminalClient } = require(path.join(scratch, 'client.cjs'))
// OpenCode chosen in the Terminal panel opens a folder-bound Work session; those run in the main process.
buildSync({ stdin: { contents: "export { OpenCodeService } from './src/main/companion/opencode.ts'; export { OpenCodeTerminalService } from './src/main/companion/terminal.ts';", resolveDir: root }, outfile: path.join(scratch, 'work.cjs'), bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
const { OpenCodeService, OpenCodeTerminalService } = require(path.join(scratch, 'work.cjs'))
let window, manager, workAgent, workTerminals
const errors = []
const openedFolders = [], openedWorkTerminals = [], closedWorkTerminals = []
const terminalWrites = []
const terminalResizes = []
let failNextWorkPoll = false
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const js = async code => { try { return await window.webContents.executeJavaScript(code, true) } catch (error) { throw new Error(error.message + '\nRenderer command: ' + code.slice(0, 200)) } }
const button = text => `[...document.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(text)})`
async function wait(code, label, timeout = 35000) { const end = Date.now() + timeout; while (!(await js(code))) { if (Date.now() > end) throw new Error('Timed out: ' + label); await sleep(100) } }
async function click(code) { await wait(`!!(${code}) && !(${code}).disabled`, 'clickable control'); await js(`(${code}).click()`); await sleep(150) }
async function select(selector, value) { await js(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('change',{bubbles:true})); })()`); await sleep(150) }
async function screenshot(name) { await sleep(300); fs.writeFileSync(path.join(scratch, name + '.png'), (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG()) }
async function checkFocusMode(kind) {
  console.log('Checking focus mode: ' + kind)
  const host = kind === 'terminal' ? '.unified-terminal-host' : '.companion-terminal:not([hidden]) .companion-terminal-host'
  if (kind === 'work') await wait(`document.querySelector('${host} .xterm-rows')?.textContent.includes('Build')`, 'native work TUI painted', 60000)
  const before = await js(`document.querySelector('${host}').getBoundingClientRect().height`)
  await js(`window.__focusTerminal = document.querySelector('${host} .xterm'); void 0`)
  const enter = `document.querySelector('[aria-label="Enter focus mode"]')`
  const leave = `document.querySelector('[aria-label="Exit focus mode"]')`
  await click(enter)
  await wait(`document.fullscreenElement === document.documentElement && !!document.querySelector('.is-focus-mode')`, kind + ' native fullscreen')
  await wait(`document.querySelector('${host}').getBoundingClientRect().height > ${before}`, kind + ' expanded terminal')
  assert.equal(await js(`getComputedStyle(document.querySelector('.app-sidebar')).display`), 'none')
  assert.equal(await js(`getComputedStyle(document.querySelector('.app-topbar')).display`), 'none')
  assert.equal(await js(`window.__focusTerminal === document.querySelector('${host} .xterm')`), true, 'fullscreen preserves the terminal DOM and input handlers')
  assert.equal(await js(`document.activeElement === document.querySelector('${host} textarea')`), true, 'fullscreen returns input focus to the terminal')
  await screenshot(kind + '-focus-light')
  await js('document.documentElement.classList.add("dark");document.documentElement.dataset.theme="dark"')
  await screenshot(kind + '-focus-dark')
  await window.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: 540, height: 900, deviceScaleFactor: 1, mobile: false })
  await sleep(250)
  assert.equal(await js(`document.documentElement.scrollWidth > innerWidth + 1`), false, 'focus view has no horizontal overflow')
  assert.equal(await js(`(() => {const r=${leave}.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.bottom<=innerHeight})()`), true, 'fullscreen exit remains visible at narrow widths')
  await screenshot(kind + '-focus-narrow')
  await window.webContents.debugger.sendCommand('Emulation.clearDeviceMetricsOverride')
  await js('document.documentElement.classList.remove("dark");document.documentElement.dataset.theme="light"')
  if (kind === 'work') {
    await click(`document.querySelector('.work-session-bar .work-bar-button')`)
    await wait(`!!document.querySelector('[role="dialog"][data-state="open"]')`, 'session dialog in fullscreen')
    assert.equal(await js(`document.fullscreenElement === document.documentElement`), true, 'portalled session dialog remains inside fullscreen')
    await screenshot('work-focus-dialog')
    await click(`[...document.querySelectorAll('[role="dialog"] button')].find(el => el.textContent.trim() === 'Cancel')`)
    await wait(`!document.querySelector('[role="dialog"][data-state="open"]')`, 'dismiss the session dialog')
    assert.equal(await js(`!!document.querySelector('.is-focus-mode')`), true, 'closing a dialog preserves focus mode')
  }
  await click(leave)
  await wait(`!document.fullscreenElement && !document.querySelector('.is-focus-mode')`, kind + ' button exits fullscreen')
  assert.equal(await js(`document.activeElement === ${enter}`), true, 'exit restores keyboard focus to its button')
  await click(enter)
  await wait(`!!document.querySelector('.is-focus-mode')`, kind + ' reenter fullscreen')
  await sleep(200)
  // Inside a terminal Esc belongs to the shell/TUI when the keyboard lock is available; otherwise
  // Electron itself leaves HTML fullscreen. Either way it must be one or the other, never both.
  const writesBeforeEscape = terminalWrites.length
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  await sleep(400)
  const escapeExited = await js(`!document.fullscreenElement && !document.querySelector('.is-focus-mode')`)
  const escapeSent = terminalWrites.slice(writesBeforeEscape).some(value => value.includes('\x1b'))
  if (kind === 'terminal') assert.notEqual(escapeExited, escapeSent, 'terminal Escape either reaches the shell or exits fullscreen, not both')
  console.log('Escape in ' + kind + ' focus mode: ' + (escapeExited ? 'exited fullscreen' : 'kept fullscreen' + (escapeSent ? ', sent to terminal' : '')))
  if (!escapeExited) {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F11' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F11' })
    await wait(`!document.fullscreenElement && !document.querySelector('.is-focus-mode')`, kind + ' F11 exits fullscreen')
  }
  assert.equal(await js(`window.__focusTerminal === document.querySelector('${host} .xterm')`), true, 'exiting never replaces the terminal')
}
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*')
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return }
  if (req.url === '/v1/models') res.end(JSON.stringify({ data: [{ id: 'qa-model' }] }))
  else res.end(JSON.stringify({ model: 'qa-model', verified: true }))
})
app.whenReady().then(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  window = new BrowserWindow({ show: false, width: 1360, height: 900, webPreferences: { offscreen: true, preload: path.join(root, 'tests/renderer/fixtures/companion-preload.cjs'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    additionalArguments: ['--unified-terminal', '--companion-qa-port=' + server.address().port, '--companion-qa-workspace=' + workspace] } })
  window.webContents.on('console-message', (_event, level, message) => { if (level === 3) errors.push(message) })
  manager = new TerminalClient({ home: path.join(scratch, 'terminal'), entry: packaged ? path.join(packaged, 'resources/app.asar/out/main/terminalHost.js') : path.join(root, 'out/main/terminalHost.js'),
    helper: packaged ? path.join(packaged, 'resources/companion-terminal/companion-pty-host.cjs') : path.join(root, 'scripts/companion-pty-host.cjs'),
    ptyModule: packaged ? path.join(packaged, 'resources/companion-terminal/node-pty') : path.join(root, 'node_modules/node-pty'), executable: packaged ? path.join(packaged, 'DailyWorkMate.exe') : undefined,
    context: async () => ({ workspaces: [{ id: 'qa-folder', name: 'Project', path: workspace, writable: false }], groups: [], persona: 'QA companion.',
      proxy: { proxyHost: '127.0.0.1', proxyPort: server.address().port, enableApiKey: false, apiKeys: [] }, executable: packaged ? path.join(packaged, 'resources/companion-runtime/opencode.exe') : path.join(root, 'companion/runtime/opencode-v2/node_modules/@opencode/cli/bin/opencode.exe') }) })
  workAgent = new OpenCodeService({ home: scratch, get: () => js('window.electronAPI.companion.get()') }, () => ({ proxyHost: '127.0.0.1', proxyPort: server.address().port, enableApiKey: false, apiKeys: [] }),
    packaged ? path.join(packaged, 'resources/companion-runtime/opencode.exe') : path.join(root, 'companion/runtime/opencode-v2/node_modules/@opencode/cli/bin/opencode.exe'))
  workTerminals = new OpenCodeTerminalService(workAgent, scratch)
  for (const [name, operation] of Object.entries({ openTerminal: async input => { const opened = await workTerminals.open(input); openedWorkTerminals.push(opened); return opened },
    pollTerminal: (id, cursor) => { if (failNextWorkPoll) { failNextWorkPoll = false; throw new Error('QA_TRANSIENT_TERMINAL_POLL') } return workTerminals.poll(id, cursor) }, writeTerminal: (id, data) => workTerminals.write(id, data),
    reconnectTerminal: (id, cols, rows) => workTerminals.reconnect(id, cols, rows), resizeTerminal: (id, cols, rows) => workTerminals.resize(id, cols, rows), closeTerminal: id => { closedWorkTerminals.push(id); return workTerminals.close(id) }, refreshAccess: () => workTerminals.refreshAccess() })) {
    ipcMain.removeHandler('qa:' + name); ipcMain.handle('qa:' + name, (_event, ...args) => operation(...args))
  }
  const operations = manager.api(async () => workspace)
  for (const [name, operation] of Object.entries(operations)) ipcMain.handle('qa:terminal:' + name, async (_event, ...args) => { if (name === 'write') terminalWrites.push(args[1]); if (name === 'resize') terminalResizes.push(args.slice(1)); return operation(...args) })
  ipcMain.handle('qa:folder:openTerminalDirectory', async (_event, id) => {
    // Mirror the production handler: resolve the ID against host state at click time.
    const state = await manager.command('state')
    const session = state.sessions.find(item => item.id === id)
    assert.ok(session, 'folder button targets an existing terminal')
    assert.ok(fs.statSync(session.directory).isDirectory())
    openedFolders.push({ id, directory: session.directory })
  })
  await window.loadFile(packaged ? path.join(packaged, 'resources/app.asar/out/renderer/index.html') : path.join(root, 'out/renderer/index.html'))
  window.webContents.debugger.attach('1.3')
  await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  await wait(`!!document.querySelector('[data-companion-ready="true"]')`, 'companion')
  await js('window.electronAPI.companion.addWorkspace()'); await window.reload(); await wait(`!!document.querySelector('[data-companion-ready="true"]')`, 'authorized folder')
  await click(button('Terminal'))
  await wait(`!!document.querySelector('[aria-label="Shell"]') && !${button('Open terminal')}.disabled`, 'terminal form')
  await click(button('Open terminal'))
  await wait(`!!document.querySelector('.unified-terminal-view:not(.is-inactive) .xterm-helper-textarea') && document.querySelector('.unified-terminal-footer')?.textContent.includes('Running')`, 'PowerShell terminal')
  // Tabs are named after the terminal's current folder, with the shell as a small badge.
  assert.deepEqual(await js(`[...document.querySelectorAll('.unified-terminal-tab')].map(el => el.querySelector('.terminal-task').textContent + '|' + el.querySelector('.terminal-kind').textContent)`), ['workspace|PS'])
  await sleep(1300)
  await js(`(() => { const el=document.querySelector('.unified-terminal-view:not(.is-inactive) .xterm-helper-textarea');el.focus();el.value="Write-Output 'UI中文输入成功' # token";el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:el.value})); })()`)
  await sleep(250); window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
  let state = await manager.command('state'); const psId = state.activeId
  await click(`document.querySelector('.unified-terminal-tabs .terminal-current-folder')`)
  assert.deepEqual(openedFolders.at(-1), { id: psId, directory: workspace })
  const end = Date.now() + 20000
  while (!/UI中文输入成功/.test((await manager.command('poll', { id: psId, cursor: 0 })).data)) { if (Date.now() > end) throw new Error('Terminal keyboard input did not reach PowerShell'); await sleep(150) }
  await checkFocusMode('terminal')
  assert.equal((await manager.command('state')).sessions.find(item => item.id === psId).createdAt, state.sessions.find(item => item.id === psId).createdAt, 'fullscreen keeps the original shell session')
  await click(`document.querySelector('[aria-label="Enter focus mode"]')`)
  await click(button('Work'))
  assert.equal(await js(`!!document.fullscreenElement && !!document.querySelector('.is-focus-mode')`), true, 'switching between Work and Terminal preserves focus mode')
  await click(button('Terminal'))
  await click(button('Chat'))
  await wait(`!document.fullscreenElement && !document.querySelector('.is-focus-mode')`, 'chat leaves focus mode')
  await click(button('Terminal'))
  await click(`document.querySelector('[aria-label="New terminal"]')`); await select('[aria-label="Shell"]', 'cmd'); await click(button('Open terminal'))
  await wait(`document.querySelectorAll('.unified-terminal-tab').length === 2`, 'second tab')
  const cmdId = (await manager.command('state')).activeId
  await click(`document.querySelector('.unified-terminal-tabs .terminal-current-folder')`)
  assert.deepEqual(openedFolders.at(-1), { id: cmdId, directory: workspace }, 'folder button follows the selected terminal')
  await click(`document.querySelector('[role="tab"][id="terminal-tab-${psId}"]')`)
  await sleep(600)
  await js(`(() => { const el=document.querySelector('.unified-terminal-view:not(.is-inactive) .xterm-helper-textarea');el.focus();el.value="Write-Output 'AFTER_SWITCH_VALID' # token";el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:el.value})); })()`)
  await sleep(200); window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
  const switchEnd = Date.now() + 15000
  while (!/\r?\nAFTER_SWITCH_VALID\r?\n/.test((await manager.command('poll', { id: psId, cursor: 0 })).data.replace(/\x1b\[[0-9;]*m/g, ''))) { if (Date.now() > switchEnd) throw new Error('Historical terminal probes corrupted the shell prompt on tab switch'); await sleep(150) }
  await js(`(() => { const el=document.querySelector('.unified-terminal-view:not(.is-inactive) .xterm-helper-textarea');el.focus();el.value="Set-Location api-sub # token";el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:el.value})); })()`)
  await sleep(200); window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
  await wait(`document.querySelector('[id="terminal-tab-${psId}"] .terminal-task')?.textContent === 'api-sub'`, 'tab name follows cd', 15000)
  assert.match(await js(`document.querySelector('[id="terminal-tab-${psId}"]').title`), /api-sub$/)
  await click(`document.querySelector('.unified-terminal-tabs .terminal-current-folder')`)
  assert.deepEqual(openedFolders.at(-1), { id: psId, directory: path.join(workspace, 'api-sub') }, 'folder button opens the latest shell cwd after cd')
  // Redraw nudges the PTY one row and back so ConPTY and the running program repaint everything.
  await sleep(400); const resizesBeforeRedraw = terminalResizes.length
  await click(`document.querySelector('.unified-terminal-view:not(.is-inactive) .terminal-redraw')`)
  await wait(`true`, 'redraw click'); await sleep(500)
  const redrawSizes = terminalResizes.slice(resizesBeforeRedraw)
  assert.equal(redrawSizes.length, 2, 'redraw sends two PTY sizes: ' + JSON.stringify(redrawSizes))
  assert.equal(redrawSizes[0][1], redrawSizes[1][1] - 1, 'first one row shorter'); assert.equal(redrawSizes[0][0], redrawSizes[1][0])
  assert.equal(await js(`document.activeElement?.classList.contains('xterm-helper-textarea')`), true, 'redraw returns focus to the terminal')
  // A long command shows the tab's activity indicator until the next prompt (OSC 7) arrives.
  assert.equal(await js(`!!document.querySelector('[id="terminal-tab-${psId}"] .terminal-activity')`), false, 'idle shell shows no activity')
  await js(`(() => { const el=document.querySelector('.unified-terminal-view:not(.is-inactive) .xterm-helper-textarea');el.focus();el.value="Start-Sleep -Seconds 5 # token";el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:el.value})); })()`)
  await sleep(200); window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
  await wait(`!!document.querySelector('[id="terminal-tab-${psId}"] .terminal-activity')`, 'a command still running after two seconds shows activity', 4500)
  await screenshot('terminal-activity')
  await wait(`!document.querySelector('[id="terminal-tab-${psId}"] .terminal-activity')`, 'activity indicator clears at the next prompt', 8000)
  const tab = `document.querySelector('[id="terminal-tab-${psId}"]')`, topTab = `[...document.querySelectorAll('.companion-tabs [role="tab"]')].find(el => el.textContent.includes('Terminal'))`
  await wait(`!!${tab}.querySelector('.terminal-done')`, 'a finished command shows done', 3000)
  assert.equal(await js(`!!${topTab}.querySelector('.terminal-done')`), true, 'the Terminal tab above shows the finished run too')
  await screenshot('terminal-done')
  const typeHere = text => js(`(() => { const el=document.querySelector('.unified-terminal-view:not(.is-inactive) .terminal-pane.is-focused .xterm-helper-textarea, .unified-terminal-view:not(.is-inactive) .xterm-helper-textarea');el.focus();el.value=${JSON.stringify(text)};el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:el.value})); })()`)
  await typeHere('#'); await wait(`!${tab}.querySelector('.terminal-done')`, 'typing in the pane clears done', 3000)
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' })
  // An interactive program that is only open (bracketed paste on, waiting for input) is never active.
  await typeHere('Write-Host -NoNewline "$([char]27)[?2004h"; Start-Sleep -Seconds 4; Write-Host -NoNewline "$([char]27)[?2004l" # token'); await sleep(200)
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
  for (let index = 0; index < 8; index++) { await sleep(400); assert.equal(await js(`!!${tab}.querySelector('.terminal-activity, .terminal-done')`), false, 'an open, idle interactive program shows no activity') }
  await sleep(1200)
  // An agent TUI announces itself: Claude Code spins ◐/◑ in the title while working and shows ✳ when waiting.
  // Opening it is not "working"; its turn is, and the end of the turn shows done although the TUI keeps running.
  const agentScript = "Write-Host -NoNewline \"$([char]27)]0;$([char]0x2733) Claude Code$([char]7)\"; Start-Sleep -Milliseconds 1500; Write-Host -NoNewline \"$([char]27)]0;$([char]0x25D0) Fix tests$([char]7)\"; Start-Sleep -Seconds 3; Write-Host -NoNewline \"$([char]27)]0;$([char]0x2733) Fix tests$([char]7)\"; Start-Sleep -Seconds 4 # token"
  await typeHere(agentScript); await sleep(200)
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
  await sleep(1000)
  assert.equal(await js(`!!${tab}.querySelector('.terminal-activity')`), false, 'an agent waiting for its first prompt is not working')
  await wait(`!!${tab}.querySelector('.terminal-activity')`, 'the agent turn shows working', 4000)
  await wait(`!!${tab}.querySelector('.terminal-done')`, 'the end of the agent turn shows done while the agent keeps running', 6000)
  assert.equal(await js(`${tab}.title.includes('Finished')`), true, 'the tab tooltip says it finished')
  await wait(`!${tab}.querySelector('.terminal-activity')`, 'the agent exiting does not restart the indicator', 6000)
  await typeHere('#'); await wait(`!${tab}.querySelector('.terminal-done')`, 'typing clears done after the agent run', 3000)
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' })
  // Compact header: Work and Terminal can fold the page title row; the one control row (tabs, model, tips, options) stays.
  const headerToggle = `document.querySelector('.companion-header-toggle')`
  const hostHeight = () => js(`document.querySelector('.unified-terminal-view:not(.is-inactive) .unified-terminal-host').getBoundingClientRect().height`)
  const fullHostHeight = await hostHeight()
  const expandedOverflow = await js(`(() => { const el = document.querySelector('.app-content'); return el.scrollHeight - el.clientHeight })()`)
  console.log('Expanded Terminal page overflow: ' + expandedOverflow + 'px')
  await click(headerToggle)
  await wait(`!!document.querySelector('.companion-page.is-header-collapsed')`, 'the header collapses')
  assert.equal(await js(`${headerToggle}.getAttribute('aria-expanded')`), 'false')
  assert.equal(await js(`document.querySelector('.companion-page > .page-header')?.getClientRects().length ?? 0`), 0, 'the page title row folds away')
  assert.equal(await js(`[...document.querySelectorAll('.companion-model-select, [data-companion-hints] > button, .companion-chat-header [data-terminal-options] > button')].every(el => el.getClientRects().length > 0)`), true, 'the model picker, tips and terminal options stay in the one control row')
  assert.equal(await js(`document.querySelector('.companion-tabs').getClientRects().length > 0 && document.querySelector('.companion-focus-toggle').getClientRects().length > 0`), true, 'view tabs and focus mode stay')
  await sleep(400); assert.ok(await hostHeight() > fullHostHeight + 50, 'the terminal gains the folded space: ' + fullHostHeight + ' -> ' + await hostHeight())
  const overflow = await js(`(() => { const el = document.querySelector('.app-content'); return el.scrollHeight - el.clientHeight })()`)
  assert.ok(overflow <= 1, 'the compact layout fits the window without page scrolling (overflow ' + overflow + 'px)')
  await screenshot('compact-header-terminal')
  await click(button('Work')); await sleep(400)
  assert.equal(await js(`!!document.querySelector('.companion-page.is-header-collapsed')`), true, 'Work uses the compact header too')
  assert.ok(await js(`(() => { const el = document.querySelector('.app-content'); return el.scrollHeight - el.clientHeight <= 1 && el.scrollTop === 0 })()`), 'Work fits without page scrolling too')
  await screenshot('compact-header-work')
  await click(button('Chat')); await sleep(300)
  assert.equal(await js(`!document.querySelector('.companion-page.is-header-collapsed') && document.querySelector('.companion-page > .page-header').getClientRects().length > 0`), true, 'Chat always shows the full header')
  await click(button('Terminal')); await sleep(300)
  await window.reload()
  await wait(`!!document.querySelector('.companion-page.is-header-collapsed') && document.querySelectorAll('.unified-terminal-tab').length === 2`, 'the compact header is remembered after reload', 20000)
  await click(headerToggle); await wait(`!document.querySelector('.companion-page.is-header-collapsed')`, 'the header expands again')
  assert.equal(await js(`document.querySelector('.companion-page > .page-header').getClientRects().length > 0 && document.querySelector('.companion-session-controls').getClientRects().length > 0`), true, 'expanding restores every row')
  // Split panes: one tab holds independent shells side by side and stacked, each with its own input and lifecycle.
  const pane = id => `document.querySelector('[data-terminal-id="${id}"]')`
  const typeInPane = async (id, text) => {
    await js(`(() => { const el=${pane(id)}.querySelector('.xterm-helper-textarea');el.focus();el.value=${JSON.stringify(text)};el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:el.value})); })()`)
    await sleep(200); window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
  }
  const paneOutput = async (id, pattern, label) => { const end = Date.now() + 15000; while (!pattern.test((await manager.command('poll', { id, cursor: 0 })).data.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ''))) { if (Date.now() > end) throw new Error('Timed out: ' + label); await sleep(150) } }
  const shortcut = (id, key, code) => js(`${pane(id)}.querySelector('.xterm-helper-textarea').dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},code:${JSON.stringify(code)},altKey:true,shiftKey:${code === 'Minus' || code === 'Equal'},bubbles:true,cancelable:true}))`)
  const activeIs = async (id, label) => { const end = Date.now() + 5000; while ((await manager.command('state')).activeId !== id) { if (Date.now() > end) throw new Error('Timed out: ' + label); await sleep(100) } }
  await click(`document.querySelector('[aria-label="Split right"]')`)
  await wait(`document.querySelectorAll('.unified-terminal-view:not(.is-inactive) .terminal-pane').length === 2 && [...document.querySelectorAll('.unified-terminal-view:not(.is-inactive) .unified-terminal-footer')].every(el => el.textContent.includes('Running'))`, 'split pane running')
  state = await manager.command('state')
  const rightId = state.activeId
  assert.notEqual(rightId, psId)
  assert.deepEqual(state.tabs.find(tab => tab.id === psId).layout, { split: 'row', ratio: 0.5, first: { pane: psId }, second: { pane: rightId } })
  assert.equal(state.sessions.find(item => item.id === rightId).directory, path.join(workspace, 'api-sub'), 'a split starts in the focused pane folder')
  assert.equal(await js(`document.querySelectorAll('.unified-terminal-tab').length`), 2, 'splitting adds no tab')
  await wait(`document.activeElement === ${pane(rightId)}.querySelector('.xterm-helper-textarea') && ${pane(rightId)}.classList.contains('is-focused')`, 'the new pane has focus')
  await sleep(1000)
  await typeInPane(rightId, "Write-Output 'PANE_RIGHT_OK' # token"); await paneOutput(rightId, /\nPANE_RIGHT_OK/, 'right pane input')
  await typeInPane(psId, "Write-Output 'PANE_LEFT_OK' # token"); await paneOutput(psId, /\nPANE_LEFT_OK/, 'left pane input')
  await activeIs(psId, 'typing in a pane focuses it')
  assert.equal(/PANE_LEFT_OK/.test((await manager.command('poll', { id: rightId, cursor: 0 })).data), false, 'input reaches only its own pane')
  assert.equal(await js(`document.querySelector('[id="terminal-tab-${psId}"] .terminal-task').textContent`), 'api-sub', 'tab label follows the focused pane')
  // Alt+Shift+- splits the focused pane down; Alt+Arrow moves focus without reaching the shell.
  const writesBeforeShortcut = terminalWrites.length
  await shortcut(psId, '_', 'Minus')
  await wait(`document.querySelectorAll('.unified-terminal-view:not(.is-inactive) .terminal-pane').length === 3`, 'Alt+Shift+- split down')
  state = await manager.command('state'); const downId = state.activeId
  assert.deepEqual(state.tabs.find(tab => tab.id === psId).layout, { split: 'row', ratio: 0.5, first: { split: 'column', ratio: 0.5, first: { pane: psId }, second: { pane: downId } }, second: { pane: rightId } })
  await wait(`${pane(downId)}.querySelector('.unified-terminal-footer').textContent.includes('Running')`, 'stacked pane running')
  await shortcut(downId, 'ArrowUp', 'ArrowUp'); await activeIs(psId, 'Alt+ArrowUp')
  await shortcut(psId, 'ArrowRight', 'ArrowRight'); await activeIs(rightId, 'Alt+ArrowRight')
  // The new pane's shell may answer terminal probes meanwhile; only Alt key sequences would be a leak.
  const afterShortcut = terminalWrites.slice(writesBeforeShortcut)
  console.log('Writes during pane shortcuts: ' + JSON.stringify(afterShortcut))
  assert.equal(afterShortcut.some(value => /\x1b(?:[_=+-]|\[1;[34][ABCD])/.test(value)), false, 'pane shortcuts are not sent to the shells')
  await wait(`document.activeElement === ${pane(rightId)}.querySelector('.xterm-helper-textarea')`, 'Alt+Arrow moves keyboard focus')
  // The divider is a keyboard-operable separator; its position is saved in the host.
  await js(`document.querySelector('.unified-terminal-view:not(.is-inactive) .terminal-divider[aria-orientation="vertical"]').focus()`)
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' })
  await wait(`document.querySelector('.unified-terminal-view:not(.is-inactive) .terminal-divider[aria-orientation="vertical"]').getAttribute('aria-valuenow') === '55'`, 'keyboard divider move')
  const ratioEnd = Date.now() + 5000
  while ((await manager.command('state')).tabs.find(tab => tab.id === psId).layout.ratio !== 0.55) { if (Date.now() > ratioEnd) throw new Error('Divider ratio was not saved'); await sleep(100) }
  await screenshot('terminal-split')
  // Closing a pane ends only that shell; the remaining panes take over its area.
  await click(`${pane(downId)}.querySelector('.terminal-pane-close')`)
  if (await js(`!!(${button('Confirm')})`)) await click(button('Confirm'))
  await wait(`document.querySelectorAll('.unified-terminal-view:not(.is-inactive) .terminal-pane').length === 2`, 'pane closed')
  state = await manager.command('state')
  assert.equal(state.sessions.some(item => item.id === downId), false)
  assert.deepEqual(state.tabs.find(tab => tab.id === psId).layout, { split: 'row', ratio: 0.55, first: { pane: psId }, second: { pane: rightId } })
  // Terminal options open from a button in the control row and float over the terminal; they take no row.
  const optionsButton = `document.querySelector('.companion-chat-header [data-terminal-options] > button')`
  assert.equal(await js(`${optionsButton}.getAttribute('aria-expanded')`), 'false', 'terminal options start closed')
  assert.equal(await js(`!!document.querySelector('.unified-terminal > [data-terminal-options], .unified-terminal-options')`), false, 'no options row above the terminal')
  await click(optionsButton)
  assert.equal(await js(`!!document.querySelector('[data-terminal-options] [role=dialog]:not([hidden]) [aria-label="Restore open terminals on startup"]') && !!document.querySelector('[data-terminal-options] [aria-label="History lines"]')`), true, 'the options panel opens with its settings')
  assert.equal(await js(`!!document.querySelector('[aria-label="Keep terminals running after exit"]')`), false)
  await screenshot('terminal-options-open')
  await js(`document.querySelector('[data-terminal-options] [role=dialog] input').focus()`)
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  await wait(`${optionsButton}.getAttribute('aria-expanded') === 'false' && document.activeElement === ${optionsButton}`, 'Esc closes the options and returns focus to their button', 3000)
  await screenshot('desktop-light')
  await click(button('Chat')); assert.equal((await manager.command('state')).sessions.length, 3, 'two panes in the first tab and the CMD tab keep running')
  await click(button('Terminal')); assert.equal((await manager.command('state')).sessions.find(item => item.id === psId).status, 'running')
  await window.reload(); await wait(`!!document.querySelector('.companion-tabs [role="tab"][aria-selected="true"]') && document.querySelector('.companion-tabs [role="tab"][aria-selected="true"]').textContent.includes('Terminal')`, 'Terminal view restored after reload')
  await wait(`document.querySelectorAll('.unified-terminal-tab').length === 2`, 'both terminals restored')
  await wait(`document.querySelectorAll('[id="terminal-panel-${psId}"] .terminal-pane').length === 2 && !!document.querySelector('[id="terminal-panel-${psId}"] .terminal-divider[aria-valuenow="55"]')`, 'split panes and divider restored after reload')
  await paneOutput(rightId, /PANE_RIGHT_OK/, 'right pane keeps its shell across reload')
  assert.equal((await manager.command('state')).preferences.keepRunningOnExit, false)
  await js('document.documentElement.classList.add("dark");document.documentElement.dataset.theme="dark"'); await screenshot('desktop-dark')
  window.setSize(540, 900); await sleep(350); await screenshot('mobile-dark')
  assert.equal(await js('document.documentElement.scrollWidth > innerWidth + 1'), false)
  await js('document.documentElement.classList.remove("dark");document.documentElement.dataset.theme="light"'); await screenshot('mobile-light')
  // Closing a running terminal uses the application confirmation.
  await click(`document.querySelector('[aria-label="Close terminal CMD"]')`)
  await click(button('Confirm'))
  await wait(`document.querySelectorAll('.unified-terminal-tab').length === 1`, 'closed tab removed')
  window.setSize(1360, 900)
  // OpenCode opens as a Work session bound to an authorized folder, not as a Terminal tab.
  await click(`document.querySelector('[aria-label="New terminal"]')`); await select('[aria-label="Shell"]', 'opencode'); await click(button('Open terminal'))
  await wait(`document.querySelector('.companion-tabs [role="tab"][aria-selected="true"]')?.textContent.includes('Work') && document.querySelector('.companion-terminal:not([hidden]) .companion-terminal-state')?.textContent === 'Connected'`, 'OpenCode Work session', 60000)
  assert.ok(await js(`/Project/.test(document.querySelector('.work-session-tab.is-active').textContent)`), 'the session is bound to the authorized folder')
  assert.equal((await manager.command('state')).sessions.some(item => item.kind === 'opencode'), false, 'no OpenCode tab in the Terminal panel')
  const liveWork = openedWorkTerminals.at(-1)
  const opensBeforeFocus = openedWorkTerminals.length, closesBeforeFocus = closedWorkTerminals.length
  await checkFocusMode('work')
  assert.equal(openedWorkTerminals.length, opensBeforeFocus, 'fullscreen never opens a replacement work process')
  assert.equal(closedWorkTerminals.length, closesBeforeFocus, 'fullscreen never closes the existing work process')
  assert.equal(workTerminals.poll(liveWork.id, 0).sessionId, liveWork.sessionId)
  const opensBeforeRecovery = openedWorkTerminals.length, closesBeforeRecovery = closedWorkTerminals.length
  failNextWorkPoll = true
  await wait(`document.querySelector('.companion-terminal:not([hidden]) .companion-terminal-state')?.dataset.phase === 'recovering'`, 'temporary output disconnect is shown as recovering')
  assert.equal(workTerminals.poll(liveWork.id, 0).running, true, 'the native terminal remains alive while its view retries')
  assert.equal(await js(`document.querySelector('.companion-terminal:not([hidden]) .companion-terminal-toolbar').textContent.includes('Reconnect')`), false, 'a temporary failure must not invite restarting the live task')
  await wait(`document.querySelector('.companion-terminal:not([hidden]) .companion-terminal-state')?.dataset.phase === 'running'`, 'automatic recovery to the same terminal')
  assert.equal(openedWorkTerminals.length, opensBeforeRecovery, 'recovery must not open a replacement native process')
  assert.equal(closedWorkTerminals.length, closesBeforeRecovery, 'recovery must not close the existing native process')
  assert.equal(workTerminals.poll(liveWork.id, 0).sessionId, liveWork.sessionId)
  assert.equal(await js(`!!document.querySelector('.companion-terminal:not([hidden]) .companion-terminal-error')`), false, 'recovered output clears the temporary connection error')
  const layouts = []
  for (const [width, height] of [[1360, 900], [540, 900]]) {
    await window.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
    for (const dark of [false, true]) {
      await js(`document.documentElement.classList.toggle('dark', ${dark});document.documentElement.dataset.theme=${JSON.stringify(dark ? 'dark' : 'light')}`)
      const bounds = {}
      for (const view of ['Work', 'Terminal']) {
        await click(button(view)); await sleep(300)
        bounds[view] = await js(`(() => {const r=document.querySelector('.companion-chat').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`)
        assert.equal(await js(`document.documentElement.scrollWidth > innerWidth + 1`), false)
        const selector = view === 'Work' ? '.companion-terminal:not([hidden]) .companion-terminal-host' : '.unified-terminal-host'
        await wait(`(() => {const h=document.querySelector('${selector}'),s=h.querySelector('.xterm-screen'),style=getComputedStyle(h);return s.getBoundingClientRect().height<=parseFloat(style.height)+1 && s.getBoundingClientRect().width<=parseFloat(style.width)+1})()`, 'terminal grid fits after layout settles', 3000).catch(async error => {
          const metrics = await js(`(() => {const h=document.querySelector('${selector}'),s=h.querySelector('.xterm-screen'),style=getComputedStyle(h);return {host:h.getBoundingClientRect().toJSON(),screen:s.getBoundingClientRect().toJSON(),width:style.width,height:style.height,box:style.boxSizing}})()`)
          throw new Error(error.message + ' ' + JSON.stringify({ view, width, dark, metrics }))
        })
        assert.equal(await js(`!!document.querySelector('${view === 'Work' ? '.work-sessions' : '.unified-terminal'} .companion-terminal-error')`), false, 'no invalid-size error while switching or resizing')
        await screenshot('aligned-' + view.toLowerCase() + '-' + width + '-' + (dark ? 'dark' : 'light'))
        assert.equal(await js(`document.querySelector('[data-companion-hints] > button').getAttribute('aria-expanded')`), 'false', 'Work and Terminal help defaults to closed')
        assert.ok(await js(`!!document.querySelector('[data-companion-hints]').closest('.companion-chat-header')`), 'help sits in the control row, not on a row of its own')
        if (view === 'Work') {
          await js(`localStorage.setItem('companion-qa-free-error', 'stale'); window.__hintTerminal = document.querySelector('.companion-terminal:not([hidden]) .xterm')`)
          await click(`document.querySelector('button[aria-label="Refresh models"]')`)
          await wait(`document.querySelector('[data-companion-hints] > button').title.includes('Free model list unavailable') && !!document.querySelector('[data-companion-hints] .header-popover-badge')`, 'catalogue error shown as a dot and tooltip')
          assert.equal(await js(`document.querySelector('[data-companion-hints] > button').getAttribute('aria-expanded')`), 'false', 'a refresh error never opens help automatically')
          await screenshot('hints-folded-' + width + '-' + (dark ? 'dark' : 'light'))
          await js(`document.querySelector('[data-companion-hints] > button').focus()`)
          assert.equal(await js(`document.activeElement === document.querySelector('[data-companion-hints] > button')`), true)
          window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
          window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
          window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
          await wait(`document.querySelector('[data-companion-hints] > button').getAttribute('aria-expanded') === 'true'`, 'keyboard opens help', 3000)
          assert.ok(await js(`(() => { const panel = document.querySelector('[data-companion-hints] [role=dialog]'); return !panel.hidden && panel.innerText.includes('QA_FREE_CATALOGUE_UNAVAILABLE') && panel.innerText.includes('Drag folders') })()`))
          assert.equal(await js(`document.documentElement.scrollWidth > innerWidth + 1`), false)
          await screenshot('hints-expanded-' + width + '-' + (dark ? 'dark' : 'light'))
          window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
          await wait(`document.querySelector('[data-companion-hints] > button').getAttribute('aria-expanded') === 'false' && document.activeElement === document.querySelector('[data-companion-hints] > button')`, 'Esc closes help and returns focus', 3000)
          assert.equal(await js(`window.__hintTerminal === document.querySelector('.companion-terminal:not([hidden]) .xterm')`), true, 'folding help preserves the live terminal')
          await js(`localStorage.removeItem('companion-qa-free-error')`)
          await click(`document.querySelector('button[aria-label="Refresh models"]')`)
          await wait(`!document.querySelector('[data-free-models-status]')`, 'catalogue recovers')
        }
      }
      assert.deepEqual(bounds.Work, bounds.Terminal, 'Work and Terminal share the same outer geometry')
      layouts.push({ width, dark, bounds })
    }
  }
  fs.writeFileSync(path.join(scratch, 'layout.json'), JSON.stringify(layouts, null, 2))
  await window.webContents.debugger.sendCommand('Emulation.clearDeviceMetricsOverride')
  await click(button('Work'))
  await workAgent.dispose() // Real server dies while its display may still be alive.
  await wait(`document.querySelector('.companion-terminal:not([hidden]) .companion-terminal-toolbar button')?.textContent.includes('Start terminal again')`, 'dead server offers explicit restart')
  await click(`document.querySelector('.companion-terminal:not([hidden]) .companion-terminal-toolbar button')`)
  await wait(`document.querySelector('.companion-terminal:not([hidden]) .companion-terminal-state')?.dataset.phase === 'running'`, 'real OpenCode restarted', 60000)
  assert.equal(openedWorkTerminals.length, opensBeforeRecovery + 1)
  assert.notEqual(openedWorkTerminals.at(-1).id, liveWork.id)
  await wait(`document.querySelector('.companion-terminal:not([hidden]) .xterm-rows')?.textContent.includes('Build')`, 'restarted TUI is usable', 60000)
  await sleep(1500); await screenshot('opencode-desktop')
  await click(`document.querySelector('.work-session-tab.is-active .work-session-close')`)
  await click(button('Confirm'))
  await wait(`!document.querySelector('.work-session-tab')`, 'Work session closed')
  await click(button('Terminal'))
  await click(`document.querySelector('button[aria-label="Switch to Chinese"]')`)
  await wait(`!!document.querySelector('[aria-label="启动时恢复未关闭终端"]')`, 'Chinese switch name')
  assert.ok(await js(`document.querySelector('.companion-tabs').textContent.includes('工作区')`))
  await screenshot('desktop-chinese')
  // Denied fullscreen must leave an ordinary usable view and permit a later retry.
  await js(`window.__requestFullscreen = document.documentElement.requestFullscreen; document.documentElement.requestFullscreen = () => Promise.reject(new Error('QA_FULLSCREEN_DENIED')); void 0`)
  await click(`document.querySelector('[aria-label="进入专注模式"]')`)
  await wait(`document.querySelector('.companion-chat [role="alert"]')?.textContent.includes('无法切换全屏')`, 'fullscreen failure is visible')
  assert.equal(await js(`!!document.fullscreenElement || !!document.querySelector('.is-focus-mode')`), false, 'failed entry does not hide app controls')
  await js(`document.documentElement.requestFullscreen = window.__requestFullscreen; void 0`)
  await click(`document.querySelector('[aria-label="进入专注模式"]')`)
  await wait(`!!document.fullscreenElement && document.querySelector('[aria-label="退出专注模式"]')?.getAttribute('aria-pressed') === 'true'`, 'Chinese fullscreen retry succeeds')
  await screenshot('terminal-focus-chinese')
  // Browser/OS fullscreen exit must synchronize the toolbar as well as button/Escape exits.
  await js('document.exitFullscreen()')
  await wait(`!document.querySelector('.is-focus-mode') && !!document.querySelector('[aria-label="进入专注模式"]')`, 'external exit synchronized')
  await click(`document.querySelector('[aria-label="启动时恢复未关闭终端"]')`)
  await wait(`!document.querySelector('[aria-label="启动时恢复未关闭终端"]').checked`, 'restoration toggle saved')
  const saved = await manager.command('state'); assert.equal(saved.preferences.restoreOnStartup, false)
  assert.equal(errors.filter(message => message.includes('QA_FULLSCREEN_DENIED')).length, 1, 'expected fullscreen rejection is logged once')
  assert.deepEqual(errors.filter(message => !message.includes('QA_FULLSCREEN_DENIED')), [])
  fs.writeFileSync(path.join(scratch, 'report.json'), JSON.stringify({ passed: true, checks: ['third Terminal tab', 'Terminal tabs show the current folder name', 'top-left folder button follows active terminal and cd', 'OpenCode opens a folder-bound Work session', 'temporary Work polling failures reconnect to the same running native process', 'PowerShell keyboard Unicode input', 'CMD second tab', 'tab selection', 'history replay leaves shell input clean', 'chat navigation retains processes', 'startup restore persists and background retention is removed', 'Work and Terminal outer geometry matches in both themes and widths', 'terminal grid fits without clipping or invalid resize errors', 'real OpenCode server death can restart a responsive TUI', 'renderer reload resumes tabs', 'split right/down panes with independent input, Alt+Arrow focus, keyboard divider, pane close and layout restore after reload', 'explicit close', 'OpenCode native TUI', 'Chinese labels', 'desktop/mobile light/dark', 'Terminal and Work native fullscreen with unchanged terminal DOM and native sessions', 'fullscreen button and Escape exits restore keyboard focus', 'fullscreen Escape is not forwarded to PowerShell', 'Work dialogs remain usable in fullscreen', 'Work/Terminal switching retains fullscreen; Chat exits', 'fullscreen rejection remains usable and can retry', 'Chinese focus controls and external fullscreen exit', 'no page overflow or unexpected renderer errors'] }, null, 2))
  console.log('PASS: unified Terminal UI, real shell input, focus mode, tab lifecycle, settings persistence and responsive themes')
}).catch(async error => { console.error(error); if (window) await screenshot('failure'); fs.writeFileSync(path.join(scratch, 'failure.json'), JSON.stringify({ error: error.message, rendererErrors: errors }, null, 2)); process.exitCode = 1 }).finally(async () => {
  if (manager) { try { const state = await manager.command('state'); for (const session of state.sessions) await manager.command('close', { id: session.id }); await manager.command('preferences', { preferences: { restoreOnStartup: true, keepRunningOnExit: false } }); await manager.detach() } catch (error) { console.error('Cleanup:', error.message) } }
  try { await workTerminals?.close() } catch (error) { console.error('[QA] Close Work sessions:', error.message) }
  window?.destroy(); server.closeAllConnections(); server.close(); console.log('QA artifacts: ' + scratch); app.exit(process.exitCode || 0)
})
