// Real Chromium wheel events against the production terminal options and CSS.
// Run after npm run build: node_modules/.bin/electron scripts/check-terminal-scroll.cjs
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..')
fs.mkdirSync(path.join(root, 'tmp'), { recursive: true })
const scratch = fs.mkdtempSync(path.join(root, 'tmp', 'terminal-scroll-'))
app.setPath('userData', path.join(scratch, 'profile'))
app.disableHardwareAcceleration()
buildSync({ stdin: { contents: `
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { terminalOptions, enableShiftWheelScroll, followScrollback, saveScrollback } from './src/renderer/src/lib/terminalDisplay';
window.saveScrollback = saveScrollback;
window.create = () => {
  window.stop?.(); window.terminal?.dispose();
  const host = document.querySelector('#host'); host.innerHTML = '';
  window.terminal = new Terminal(terminalOptions(false)); const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(host); fit.fit();
  const stopWheel = enableShiftWheelScroll(terminal, host), stopScrollback = followScrollback(terminal);
  window.stop = () => { stopWheel(); stopScrollback() };
  window.sent = []; terminal.onData(value => sent.push(value));
};
window.write = text => new Promise(resolve => terminal.write(text, resolve));
window.state = () => ({ viewportY: terminal.buffer.active.viewportY, baseY: terminal.buffer.active.baseY, type: terminal.buffer.active.type, scrollback: terminal.options.scrollback, sent: sent.splice(0) });`,
resolveDir: root }, outfile: path.join(scratch, 'renderer.js'), bundle: true, platform: 'browser' })
const assets = path.join(root, 'out/renderer/assets')
const css = ['bootstrap-', 'Companion-', 'xterm-'].map(prefix => {
  const file = fs.readdirSync(assets).find(name => name.startsWith(prefix) && name.endsWith('.css'))
  if (!file) throw new Error('Missing built CSS: ' + prefix + '. Run npm run build first.')
  return fs.readFileSync(path.join(assets, file), 'utf8')
}).join('\n')
fs.writeFileSync(path.join(scratch, 'index.html'), `<html><head><meta charset="utf-8"><style>${css}</style></head><body><div class="unified-terminal-host" id="host" style="height:360px;width:900px"></div><script src="renderer.js"></script></body></html>`)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const history = Array.from({ length: 300 }, (_, index) => 'LINE ' + (index + 1)).join('\r\n') + '\r\n'
let window
app.whenReady().then(async () => {
  window = new BrowserWindow({ show: false, width: 1000, height: 460, webPreferences: { offscreen: true, backgroundThrottling: false } })
  await window.loadFile(path.join(scratch, 'index.html'))
  const js = code => window.webContents.executeJavaScript(code, true)
  // A physical wheel notch: Chromium reports both deltaY and wheel ticks.
  const wheelUp = async (shift = false) => { for (let index = 0; index < 3; index++) window.webContents.sendInputEvent({ type: 'mouseWheel', x: 300, y: 150, deltaX: 0, deltaY: 120, wheelTicksX: 0, wheelTicksY: 1, accelerationRatioX: 1, accelerationRatioY: 1, hasPreciseScrollingDeltas: false, canScroll: true, modifiers: shift ? ['shift'] : [] }); await sleep(300) }
  const scenario = async (prefix) => { await js('create()'); await js('write(' + JSON.stringify(history + prefix) + ')'); await sleep(150); return js('state()') }

  let before = await scenario('')
  assert.ok(before.baseY > 0, 'history lines exist')
  await wheelUp(); let after = await js('state()')
  assert.ok(after.viewportY < before.viewportY, 'the wheel scrolls a plain shell')
  assert.deepEqual(after.sent, [], 'plain scrolling sends nothing to the shell')

  before = await scenario('\x1b[?1000h\x1b[?1006h')
  await wheelUp(); after = await js('state()')
  assert.equal(after.viewportY, before.viewportY, 'a mouse-capturing TUI receives the wheel instead')
  assert.ok(after.sent.some(value => value.startsWith('\x1b[<64;')), 'the wheel reaches the TUI as mouse input')
  await wheelUp(true); after = await js('state()')
  assert.ok(after.viewportY < before.viewportY, 'Shift+wheel scrolls the terminal history while a TUI captures the mouse')
  assert.deepEqual(after.sent, [], 'Shift+wheel is not sent to the TUI')

  before = await scenario('\x1b[?1049h')
  await wheelUp(true); after = await js('state()')
  assert.equal(after.type, 'alternate'); assert.equal(after.viewportY, 0)
  assert.deepEqual(after.sent, [], 'Shift+wheel does nothing on the alternate screen, which has no history')

  await scenario('')
  assert.equal((await js('state()')).scrollback, 10000, 'default history size')
  await js('saveScrollback(1000)'); assert.equal((await js('state()')).scrollback, 1000, 'history size changes apply to open terminals')
  await js('saveScrollback(10000)')
  console.log('PASS: wheel scrolls shells, reaches mouse-capturing TUIs, Shift+wheel scrolls history, history size applies live')
}).catch(error => { console.error(error); process.exitCode = 1 }).finally(() => {
  window?.destroy(); console.log('QA artifacts: ' + scratch); app.exit(process.exitCode || 0)
})
