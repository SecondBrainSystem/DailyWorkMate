// Run after npm run build with Electron. Hidden, isolated profiles; no workspace selection or real accounts.
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const root = path.resolve(__dirname, '..')
fs.mkdirSync(path.join(root, 'tmp'), { recursive: true })
const scratch = fs.mkdtempSync(path.join(root, 'tmp', 'startup-input-ui-'))
app.setPath('userData', path.join(scratch, 'profile'))
app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')
  if (req.method === 'OPTIONS') return res.writeHead(204).end()
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ data: [{ id: 'qa-model' }] }))
})
let window
const errors = []
const progress = label => { fs.appendFileSync(path.join(scratch, 'progress.log'), label + '\n'); console.log(label) }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const js = code => window.webContents.executeJavaScript(code, true)
async function wait(code, label) {
  const end = Date.now() + 15000
  while (!await js(code)) { if (Date.now() > end) throw new Error('Timeout: ' + label); await sleep(60) }
}
async function type(selector, text) {
  progress('Typing: ' + text)
  await wait(`!!document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled`, selector)
  await js(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'center' })`)
  await sleep(250)
  const point = await js(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.x + Math.min(r.width / 2, 40)), y: Math.round(r.y + r.height / 2) } })()`)
  // Actual mouse and keyboard events: assigning .value would conceal a lost focus bug.
  window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
  window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
  await wait(`document.activeElement === document.querySelector(${JSON.stringify(selector)})`, 'input receives mouse focus')
  const before = await js(`document.querySelector(${JSON.stringify(selector)}).value`)
  for (const keyCode of text) {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode })
    window.webContents.sendInputEvent({ type: 'char', keyCode })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode })
  }
  await wait(`document.querySelector(${JSON.stringify(selector)}).value.length === ${before.length + text.length}`, 'keyboard input reaches the field')
  assert.ok((await js(`document.querySelector(${JSON.stringify(selector)}).value`)).includes(text))
}
async function open(fixture, hash) {
  progress('Opening: ' + fixture)
  window = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: {
    preload: path.join(root, 'tests/renderer/fixtures', fixture + '-preload.cjs'),
    offscreen: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    partition: 'persist:startup-' + fixture,
    additionalArguments: ['--companion-qa-port=' + server.address().port, '--chat-qa-port=' + server.address().port],
  } })
  window.webContents.on('console-message', (_event, level, message) => { if (level === 3) errors.push(message) })
  await window.loadFile(path.join(root, 'out/renderer/index.html'), { hash })
  progress('Loaded: ' + fixture)
  window.webContents.debugger.attach('1.3')
  // Hidden UI acceptance uses focus emulation; native-window recovery is covered in input-focus.test.ts.
  await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
}
const watchdog = setTimeout(() => { console.error('Startup input QA exceeded 60 seconds'); if (window && !window.isDestroyed()) window.destroy(); app.exit(1) }, 60000)
app.whenReady().then(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  await open('companion', '/')
  await wait(`!!document.querySelector('[data-companion-ready="true"]')`, 'fresh assistant')
  await type('.companion-composer textarea', 'firstchat')
  assert.equal(await js(`window.electronAPI.companion.get().then(result => result.workspaces.length)`), 0)
  await js(`document.querySelector('button[aria-label="Folder access"]').click()`)
  await wait(`!![...document.querySelectorAll('button')].find(el => el.textContent.trim() === 'Manage groups')`, 'folder panel')
  await js(`[...document.querySelectorAll('button')].find(el => el.textContent.trim() === 'Manage groups').click()`)
  await wait(`document.querySelector('[role="dialog"]')?.textContent.includes('Group name')`, 'group panel')
  await type('[role="dialog"] input[maxlength="80"]', 'firstgroup')
  await js(`[...document.querySelectorAll('[role="dialog"] button')].find(el => el.textContent.trim() === 'Close').click()`)
  await wait(`!document.querySelector('[role="dialog"]')`, 'group panel closed')
  await type('.companion-composer textarea', 'afterdialog')
  await sleep(500)
  const loaded = new Promise(resolve => window.webContents.once('did-finish-load', resolve))
  window.reload(); await loaded
  await wait(`!!document.querySelector('[data-companion-ready="true"]')`, 'assistant after reload')
  await type('.companion-composer textarea', 'afterreload')
  window.destroy()
  await open('chat', '/chat')
  await wait(`!!document.querySelector('[data-chat-ready="true"]')`, 'fresh task chat')
  await type('textarea', 'firsttaskchat')
  assert.deepEqual(errors, [])
  fs.writeFileSync(path.join(scratch, 'report.json'), JSON.stringify({ passed: true, checks: ['fresh companion mouse and keyboard', 'group name without any workspace', 'input after closing dialog', 'input after reload', 'fresh task chat mouse and keyboard'], errors }, null, 2))
  console.log('PASS: startup input UI. Evidence: ' + scratch)
}).catch(async error => {
  console.error(error); process.exitCode = 1
  if (window && !window.isDestroyed()) {
    try { fs.writeFileSync(path.join(scratch, 'failure.txt'), await js('document.body.innerText')) }
    catch (failure) { console.error('Could not capture failure:', failure) }
  }
}).finally(() => { clearTimeout(watchdog); if (window && !window.isDestroyed()) window.destroy(); server.closeAllConnections(); server.close(); app.exit(process.exitCode || 0) })
