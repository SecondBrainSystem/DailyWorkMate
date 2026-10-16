// Real Chromium composition events against the production terminal CSS and xterm renderer.
// Run after npm run build: node_modules/.bin/electron scripts/check-terminal-ime.cjs
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..')
const scratch = fs.mkdtempSync(path.join(root, 'tmp', 'terminal-ime-regression-'))
app.setPath('userData', path.join(scratch, 'profile'))
app.disableHardwareAcceleration()
buildSync({ stdin: { contents: `
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { forwardImeSpaces } from './src/renderer/src/lib/terminalInput';
window.create = (kind, baseline = false) => {
  window.spaces?.dispose(); window.terminal?.dispose();
  const host = document.querySelector('#host'); host.innerHTML = '';
  host.className = kind;
  document.querySelector('#baseline').textContent = baseline
    ? '.unified-terminal-host .xterm,.companion-terminal-host .xterm{text-spacing-trim:normal}' : '';
  window.terminal = new Terminal({ cursorBlink: false, cursorStyle: 'bar',
    fontFamily: 'Consolas, "Cascadia Mono", Menlo, monospace', fontSize: 14, lineHeight: 1.15,
    theme: { background: '#16181d', foreground: '#e4e4e7' } });
  window.fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(host); fit.fit();
  window.spaces = forwardImeSpaces(terminal);
  window.sent = []; terminal.onData(value => { sent.push(value); terminal.write(value); });
  terminal.focus();
};
window.write = text => new Promise(resolve => terminal.write(text, resolve));
window.measure = () => {
  const cursor = document.querySelector('.xterm-cursor');
  const composition = document.querySelector('.composition-view');
  const sample = document.querySelector('.xterm-char-measure-element');
  const rect = el => el?.getBoundingClientRect().toJSON();
  return { cursor: rect(cursor), composition: rect(composition), row: cursor?.parentElement.textContent,
    rowSpacing: cursor && getComputedStyle(cursor).textSpacingTrim,
    sampleSpacing: sample && getComputedStyle(sample).textSpacingTrim,
    sent: [...sent], active: composition.classList.contains('active') };
};`, resolveDir: root }, outfile: path.join(scratch, 'renderer.js'), bundle: true, platform: 'browser' })
const assets = path.join(root, 'out/renderer/assets')
const css = ['bootstrap-', 'Companion-', 'xterm-'].map(prefix => {
  const file = fs.readdirSync(assets).find(name => name.startsWith(prefix) && name.endsWith('.css'))
  if (!file) throw new Error('Missing built CSS: ' + prefix + '. Run npm run build first.')
  return fs.readFileSync(path.join(assets, file), 'utf8')
}).join('\n')
fs.writeFileSync(path.join(scratch, 'index.html'), `<html><head><meta charset="utf-8"><style>${css}</style><style id="baseline"></style></head><body><div id="host" style="height:350px;margin:20px;background:#16181d"></div><script src="renderer.js"></script></body></html>`)
let window
const results = []
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const js = code => window.webContents.executeJavaScript(code, true)
const compose = text => window.webContents.debugger.sendCommand('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length })
const text = '请检查，配置，测试，你需要'
async function measure(name, checked = true) {
  await sleep(80)
  const measured = await js('measure()')
  const difference = measured.composition.x - measured.cursor?.x
  results.push({ name, difference, ...measured })
  fs.writeFileSync(path.join(scratch, name + '.png'), (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG())
  if (checked) {
    assert.ok(measured.active, name + ': IME preedit is visible')
    assert.ok(Math.abs(difference) < 1, name + ': IME follows the rendered cursor; offset=' + difference)
    assert.ok(Math.abs(measured.composition.y - measured.cursor.y) < 1, name + ': IME stays on the input row')
    assert.equal(measured.rowSpacing, 'space-all', name + ': full punctuation spacing in rows')
    assert.equal(measured.sampleSpacing, 'space-all', name + ': same punctuation spacing in width measurement')
  }
}
app.whenReady().then(async () => {
  window = new BrowserWindow({ show: false, width: 1100, height: 450, webPreferences: { offscreen: true, backgroundThrottling: false } })
  await window.loadFile(path.join(scratch, 'index.html'))
  window.webContents.debugger.attach('1.3')
  await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  // Negative control: reproduce the old overlap with identical fonts, content and viewport.
  await js("create('unified-terminal-host', true)")
  await js('write(' + JSON.stringify(text) + ')'); await compose("shan'chu'diao")
  await measure('before-punctuation-spacing', false); await compose('')
  for (const host of ['unified-terminal-host', 'companion-terminal-host']) {
    await js('create(' + JSON.stringify(host) + ')')
    await js('write(' + JSON.stringify(text) + ')'); await compose("shan'chu'diao")
    await measure(host + '-first-ime')
    await window.webContents.insertText('删除')
    await sleep(100)
    assert.equal(await js("sent.join('')"), '删除', 'committed Chinese is delivered exactly once')
    await compose('duo')
    await measure(host + '-next-ime'); await compose('')
    assert.equal(await js("sent.join('')"), '删除', 'canceling composition sends no extra characters')
    await js('write("。中文、标点（括号）【测试】ABC 123，配置你需要")')
    await compose('ce\'shi')
    await measure(host + '-mixed-punctuation'); await compose('')
  }
  await js("create('unified-terminal-host')")
  await js('write(' + JSON.stringify(text) + ')'); await compose('ce\'shi')
  window.setSize(950, 450); await js('fit.fit()')
  await measure('resize-during-ime'); await compose('')
  window.webContents.setZoomFactor(1.25); await sleep(100); await js('fit.fit();terminal.focus()')
  await compose('ce\'shi'); await measure('zoomed-ime'); await compose('')
  console.log(JSON.stringify({ scratch, results: results.map(({ name, difference }) => ({ name, difference })) }, null, 2))
}).catch(error => { console.error(error); process.exitCode = 1 }).finally(() => {
  fs.writeFileSync(path.join(scratch, 'report.json'), JSON.stringify(results, null, 2))
  window?.destroy(); console.log('QA artifacts: ' + scratch); app.exit(process.exitCode || 0)
})
