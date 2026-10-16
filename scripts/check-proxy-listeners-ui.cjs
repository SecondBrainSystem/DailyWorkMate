// Run with Electron after npm run build. All services and storage are isolated fixtures.
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const labels = require('../src/renderer/src/i18n/locales/en-US.json')
const root = path.resolve(__dirname, '..'), output = path.join(root, 'tmp', 'qa')
fs.mkdirSync(output, { recursive: true })
app.setPath('userData', path.join(output, 'proxy-listeners-ui-profile-' + process.pid))
app.disableHardwareAcceleration()
const results = [], errors = []
let win
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const js = code => win.webContents.executeJavaScript(code, true)
const button = (text, scope = 'document') => `[...${scope}.querySelectorAll('button')].find(el=>el.textContent.trim()===${JSON.stringify(text)})`
const row = port => `document.querySelector('[data-proxy-listener="127.0.0.1:${port}"]')`
async function waitFor(code, label) {
  for (let i = 0; i < 100; i++) { if (await js(code)) return; await delay(40) }
  throw new Error('Timed out: ' + label)
}
async function click(code) {
  const point = await js(`(()=>{const el=(${code});if(!el)throw new Error('Missing control');el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
  await delay(100)
}
async function input(id, value) {
  await js(`(()=>{const el=document.getElementById(${JSON.stringify(id)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  await delay(50)
}
const snapshot = () => js('window.proxyListenersQA.snapshot()')
const timeout = setTimeout(() => { console.error('Proxy listeners QA timeout'); app.exit(1) }, 55000)
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ show: false, width: 1280, height: 1000, webPreferences: {
      preload: path.join(root, 'tests/renderer/fixtures/proxy-listeners-preload.cjs'),
      contextIsolation: true, sandbox: false, backgroundThrottling: false,
    } })
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 3 && !message.includes('QA ')) errors.push(message) })
    await win.loadFile(path.join(root, 'out/renderer/index.html'), { hash: '/proxy' })
    await waitFor("document.getElementById('additional-proxy-port')&&!document.getElementById('additional-proxy-port').disabled", 'service list loaded')
    assert.equal(await js("document.getElementById('port').value"), '32123')
    await click(button(labels.proxy.listenerAddStart))
    await waitFor(`!!(${button(labels.proxy.listenerStop, row(11434))})`, 'secondary service running')
    assert.deepEqual((await snapshot()).active.map(endpoint => endpoint.port).sort(), [11434, 32123])
    assert.equal((await snapshot()).config.proxyPort, 32123)
    results.push('Adding 11434 while workspace service 32123 is running starts both and preserves the primary address')

    await click(button(labels.proxy.listenerStop, row(11434)))
    assert.deepEqual((await snapshot()).active.map(endpoint => endpoint.port), [32123])
    assert.deepEqual((await snapshot()).config.additionalProxyListeners, [{ host: '127.0.0.1', port: 11434 }])
    results.push('Stopping an additional service leaves the primary running and retains the saved definition')

    await input('additional-proxy-port', '11435')
    await js('window.proxyListenersQA.failSave(true)')
    await click(button(labels.proxy.listenerAddStart))
    await waitFor("document.body.innerText.includes('QA disk write failed')", 'failed add save visible')
    assert.equal((await snapshot()).calls.some(call => call.action === 'start' && call.port === 11435), false)
    assert.equal((await snapshot()).config.additionalProxyListeners.length, 1)
    results.push('Failed service configuration save shows the error and does not start an unsaved service')

    await js('window.proxyListenersQA.failSave(false);window.proxyListenersQA.failPort(11435)')
    await click(button(labels.proxy.listenerAddStart))
    await waitFor("document.body.innerText.includes('QA port 11435 is in use')", 'bind failure visible')
    assert.deepEqual((await snapshot()).active.map(endpoint => endpoint.port), [32123])
    assert.ok((await snapshot()).config.additionalProxyListeners.some(endpoint => endpoint.port === 11435))
    await js('window.proxyListenersQA.failPort(null)')
    await click(button(labels.proxy.listenerStart, row(11435)))
    assert.deepEqual((await snapshot()).active.map(endpoint => endpoint.port).sort(), [11435, 32123])
    results.push('Port conflict stays visible, preserves running services and allows retry from the saved row')

    await input('port', '32124')
    await js('window.proxyListenersQA.failPort(32124)')
    await click(button(labels.proxy.saveConfig))
    await waitFor("!!document.querySelector('[role=dialog]')", 'primary migration dialog')
    await click(button(labels.proxy.changePrimaryConfirm, "document.querySelector('[role=dialog]')"))
    await waitFor("!document.querySelector('[role=dialog]')", 'failed migration finished')
    assert.equal((await snapshot()).config.proxyPort, 32123)
    assert.ok((await snapshot()).active.some(endpoint => endpoint.port === 32123))
    results.push('Failed primary bind preserves the previous primary configuration and service')

    await js('window.proxyListenersQA.failPort(null);window.proxyListenersQA.failSave(true)')
    await click(button(labels.proxy.saveConfig))
    await waitFor("!!document.querySelector('[role=dialog]')", 'migration save failure dialog')
    await click(button(labels.proxy.changePrimaryConfirm, "document.querySelector('[role=dialog]')"))
    await waitFor("!document.querySelector('[role=dialog]')", 'migration rollback complete')
    assert.equal((await snapshot()).config.proxyPort, 32123)
    assert.deepEqual((await snapshot()).active.map(endpoint => endpoint.port).sort(), [11435, 32123])
    assert.ok((await snapshot()).calls.some(call => call.action === 'stop' && call.port === 32124 && call.host === '127.0.0.1'))
    assert.equal((await snapshot()).calls.some(call => call.action === 'stop' && call.port === undefined), false)
    results.push('Failed primary save rolls back only the newly started endpoint; other listeners stay running')

    await js('window.proxyListenersQA.failSave(false)')
    await click(button(labels.proxy.saveConfig))
    await waitFor("!!document.querySelector('[role=dialog]')", 'successful migration dialog')
    await click(button(labels.proxy.changePrimaryConfirm, "document.querySelector('[role=dialog]')"))
    await waitFor("!document.querySelector('[role=dialog]')", 'migration saved')
    assert.equal((await snapshot()).config.proxyPort, 32124)
    assert.deepEqual((await snapshot()).active.map(endpoint => endpoint.port).sort(), [11435, 32123, 32124])
    assert.ok((await snapshot()).config.additionalProxyListeners.some(endpoint => endpoint.port === 32123))
    results.push('Changing primary keeps the previous address running and saves it as an additional service')

    await new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.webContents.reload() })
    await waitFor(`!!(${row(11434)})&&!!(${row(32123)})&&document.getElementById('port').value==='32124'`, 'saved services restored')
    await click(button(labels.proxy.listenerRemove, row(11435)))
    assert.equal((await snapshot()).active.some(endpoint => endpoint.port === 11435), false)
    assert.equal((await snapshot()).config.additionalProxyListeners.some(endpoint => endpoint.port === 11435), false)
    assert.ok((await snapshot()).active.some(endpoint => endpoint.port === 32124))
    results.push('Saved services survive reload; removal stops only that endpoint and removes its definition')
    await input('additional-proxy-port', '11434.5')
    await click(button(labels.proxy.listenerAddStart))
    assert.equal(await js("document.getElementById('additional-proxy-port').getAttribute('aria-invalid')"), 'true')
    assert.equal(await js("document.documentElement.scrollWidth <= window.innerWidth + 1"), true)
    await js("document.getElementById('additional-proxy-port').scrollIntoView({block:'center'})")
    await delay(150)
    fs.writeFileSync(path.join(output, 'proxy-listeners-ui.png'), (await win.webContents.capturePage()).toPNG())
    assert.deepEqual(errors, [])
    const result = JSON.stringify({ results, errors }, null, 2)
    fs.writeFileSync(path.join(output, 'proxy-listeners-ui-results.json'), result)
    console.log(result)
    clearTimeout(timeout); win.destroy(); app.exit(0)
  } catch (error) {
    console.error(error)
    if (win) console.error(await js('document.body.innerText').catch(() => 'Page unavailable'))
    clearTimeout(timeout); app.exit(1)
  }
})
