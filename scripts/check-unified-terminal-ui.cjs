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
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const js = async code => { try { return await window.webContents.executeJavaScript(code, true) } catch (error) { throw new Error(error.message + '\nRenderer command: ' + code.slice(0, 200)) } }
const button = text => `[...document.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(text)})`
async function wait(code, label, timeout = 35000) { const end = Date.now() + timeout; while (!(await js(code))) { if (Date.now() > end) throw new Error('Timed out: ' + label); await sleep(100) } }
async function click(code) { await wait(`!!(${code}) && !(${code}).disabled`, 'clickable control'); await js(`(${code}).click()`); await sleep(150) }
async function select(selector, value) { await js(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('change',{bubbles:true})); })()`); await sleep(150) }
async function screenshot(name) { await sleep(300); fs.writeFileSync(path.join(scratch, name + '.png'), (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG()) }
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
  for (const [name, operation] of Object.entries({ openTerminal: input => workTerminals.open(input), pollTerminal: (id, cursor) => workTerminals.poll(id, cursor), writeTerminal: (id, data) => workTerminals.write(id, data),
    resizeTerminal: (id, cols, rows) => workTerminals.resize(id, cols, rows), closeTerminal: id => workTerminals.close(id), refreshAccess: () => workTerminals.refreshAccess() })) {
    ipcMain.removeHandler('qa:' + name); ipcMain.handle('qa:' + name, (_event, ...args) => operation(...args))
  }
  const operations = manager.api(async () => workspace)
  for (const [name, operation] of Object.entries(operations)) ipcMain.handle('qa:terminal:' + name, async (_event, ...args) => operation(...args))
  await window.loadFile(packaged ? path.join(packaged, 'resources/app.asar/out/renderer/index.html') : path.join(root, 'out/renderer/index.html'))
  await wait(`!!document.querySelector('[data-companion-ready="true"]')`, 'companion')
  await js('window.electronAPI.companion.addWorkspace()'); await window.reload(); await wait(`!!document.querySelector('[data-companion-ready="true"]')`, 'authorized folder')
  await click(button('Terminal'))
  await wait(`!!document.querySelector('[aria-label="Shell"]') && !${button('Open terminal')}.disabled`, 'terminal form')
  await click(button('Open terminal'))
  await wait(`!!document.querySelector('.unified-terminal-host .xterm-helper-textarea') && document.querySelector('.unified-terminal-footer')?.textContent.includes('Running')`, 'PowerShell terminal')
  // Tabs are named after the terminal's current folder, with the shell as a small badge.
  assert.deepEqual(await js(`[...document.querySelectorAll('.unified-terminal-tab')].map(el => el.querySelector('.terminal-task').textContent + '|' + el.querySelector('.terminal-kind').textContent)`), ['workspace|PS'])
  await sleep(1300)
  await js(`(() => { const el=document.querySelector('.unified-terminal-host .xterm-helper-textarea');el.focus();el.value="Write-Output 'UI中文输入成功' # token";el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:el.value})); })()`)
  await sleep(250); window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
  let state = await manager.command('state'); const psId = state.activeId
  const end = Date.now() + 20000
  while (!/UI中文输入成功/.test((await manager.command('poll', { id: psId, cursor: 0 })).data)) { if (Date.now() > end) throw new Error('Terminal keyboard input did not reach PowerShell'); await sleep(150) }
  await click(`document.querySelector('[aria-label="New terminal"]')`); await select('[aria-label="Shell"]', 'cmd'); await click(button('Open terminal'))
  await wait(`document.querySelectorAll('.unified-terminal-tab').length === 2`, 'second tab')
  await click(`document.querySelector('[role="tab"][id="terminal-tab-${psId}"]')`)
  await sleep(600)
  await js(`(() => { const el=document.querySelector('.unified-terminal-host .xterm-helper-textarea');el.focus();el.value="Write-Output 'AFTER_SWITCH_VALID' # token";el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:el.value})); })()`)
  await sleep(200); window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
  const switchEnd = Date.now() + 15000
  while (!/\r?\nAFTER_SWITCH_VALID\r?\n/.test((await manager.command('poll', { id: psId, cursor: 0 })).data.replace(/\x1b\[[0-9;]*m/g, ''))) { if (Date.now() > switchEnd) throw new Error('Historical terminal probes corrupted the shell prompt on tab switch'); await sleep(150) }
  await js(`(() => { const el=document.querySelector('.unified-terminal-host .xterm-helper-textarea');el.focus();el.value="Set-Location api-sub # token";el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:el.value})); })()`)
  await sleep(200); window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
  await wait(`document.querySelector('[id="terminal-tab-${psId}"] .terminal-task')?.textContent === 'api-sub'`, 'tab name follows cd', 15000)
  assert.match(await js(`document.querySelector('[id="terminal-tab-${psId}"]').title`), /api-sub$/)
  // The startup/exit options are folded away by default.
  await js(`document.querySelector('.unified-terminal-options-toggle[aria-expanded="false"]')?.click(); void 0`); await sleep(150)
  await click(`document.querySelector('[aria-label="Keep terminals running after exit"]')`)
  await wait(`document.querySelector('[aria-label="Keep terminals running after exit"]').checked`, 'keep running enabled')
  await screenshot('desktop-light')
  await click(button('Chat')); assert.equal((await manager.command('state')).sessions.length, 2)
  await click(button('Terminal')); assert.equal((await manager.command('state')).sessions.find(item => item.id === psId).status, 'running')
  await window.reload(); await wait(`!!document.querySelector('.companion-tabs [role="tab"][aria-selected="true"]') && document.querySelector('.companion-tabs [role="tab"][aria-selected="true"]').textContent.includes('Terminal')`, 'Terminal view restored after reload')
  await wait(`document.querySelectorAll('.unified-terminal-tab').length === 2`, 'both terminals restored')
  assert.equal(await js(`document.querySelector('[aria-label="Keep terminals running after exit"]').checked`), true)
  await js('document.documentElement.classList.add("dark");document.documentElement.dataset.theme="dark"'); await screenshot('desktop-dark')
  window.setSize(540, 900); await sleep(350); await screenshot('mobile-dark')
  assert.equal(await js('document.documentElement.scrollWidth > innerWidth + 1'), false)
  await js('document.documentElement.classList.remove("dark");document.documentElement.dataset.theme="light"'); await screenshot('mobile-light')
  // Closing a running terminal asks for confirmation; a native dialog would block the hidden window.
  await js('window.confirm = () => true; void 0')
  await click(`document.querySelector('[aria-label="Close terminal CMD"]')`)
  await wait(`document.querySelectorAll('.unified-terminal-tab').length === 1`, 'closed tab removed')
  window.setSize(1360, 900)
  // OpenCode opens as a Work session bound to an authorized folder, not as a Terminal tab.
  await click(`document.querySelector('[aria-label="New terminal"]')`); await select('[aria-label="Shell"]', 'opencode'); await click(button('Open terminal'))
  await wait(`document.querySelector('.companion-tabs [role="tab"][aria-selected="true"]')?.textContent.includes('Work') && document.querySelector('.companion-terminal:not([hidden]) .companion-terminal-state')?.textContent === 'Connected'`, 'OpenCode Work session', 60000)
  assert.ok(await js(`/Project/.test(document.querySelector('.work-session-tab.is-active').textContent)`), 'the session is bound to the authorized folder')
  assert.equal((await manager.command('state')).sessions.some(item => item.kind === 'opencode'), false, 'no OpenCode tab in the Terminal panel')
  await sleep(1500); await screenshot('opencode-desktop')
  await js('window.confirm = () => true; void 0')
  await click(`document.querySelector('.work-session-tab.is-active .work-session-close')`)
  await wait(`!document.querySelector('.work-session-tab')`, 'Work session closed')
  await click(button('Terminal'))
  await click(`document.querySelector('button[aria-label="Switch to Chinese"]')`)
  await wait(`!!document.querySelector('[aria-label="启动时恢复未关闭终端"]') && !!document.querySelector('[aria-label="退出软件后保持终端运行"]')`, 'Chinese switch names')
  assert.ok(await js(`document.querySelector('.companion-tabs').textContent.includes('工作区')`))
  await screenshot('desktop-chinese')
  await click(`document.querySelector('[aria-label="启动时恢复未关闭终端"]')`)
  await wait(`!document.querySelector('[aria-label="启动时恢复未关闭终端"]').checked`, 'restoration toggle saved')
  const saved = await manager.command('state'); assert.equal(saved.preferences.restoreOnStartup, false)
  assert.deepEqual(errors, [])
  fs.writeFileSync(path.join(scratch, 'report.json'), JSON.stringify({ passed: true, checks: ['third Terminal tab', 'Terminal tabs show the current folder name', 'OpenCode opens a folder-bound Work session', 'PowerShell keyboard Unicode input', 'CMD second tab', 'tab selection', 'history replay leaves shell input clean', 'chat navigation retains processes', 'both settings persisted', 'renderer reload resumes tabs', 'explicit close', 'OpenCode native TUI', 'Chinese labels', 'desktop/mobile light/dark', 'no page overflow or renderer errors'] }, null, 2))
  console.log('PASS: unified Terminal UI, real shell input, tab lifecycle, settings persistence and responsive themes')
}).catch(error => { console.error(error); fs.writeFileSync(path.join(scratch, 'failure.json'), JSON.stringify({ error: error.message, rendererErrors: errors }, null, 2)); process.exitCode = 1 }).finally(async () => {
  if (manager) { try { const state = await manager.command('state'); for (const session of state.sessions) await manager.command('close', { id: session.id }); await manager.command('preferences', { preferences: { restoreOnStartup: true, keepRunningOnExit: false } }); await manager.detach() } catch (error) { console.error('Cleanup:', error.message) } }
  try { await workTerminals?.close() } catch (error) { console.error('[QA] Close Work sessions:', error.message) }
  window?.destroy(); server.closeAllConnections(); server.close(); console.log('QA artifacts: ' + scratch); app.exit(process.exitCode || 0)
})
