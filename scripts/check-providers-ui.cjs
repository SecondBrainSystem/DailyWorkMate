// Providers page: web accounts and official APIs in separate tabs, adding an official API key. Isolated fixture.
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const output = path.join(root, 'tmp', 'qa')
fs.mkdirSync(output, { recursive: true })
app.setPath('userData', fs.mkdtempSync(path.join(root, 'tmp', 'providers-ui-')))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let window
const errors = []
const js = code => window.webContents.executeJavaScript(code, true)
async function waitFor(code, label, timeout = 15000) {
  const end = Date.now() + timeout
  while (!(await js(code))) { if (Date.now() > end) throw new Error('Timed out: ' + label); await sleep(80) }
}
const button = text => `[...document.querySelectorAll('button')].find(el => el.textContent.trim().startsWith(${JSON.stringify(text)}))`
// Radix tabs switch on mousedown, as a real click does; a synthetic click() alone does not.
async function tab(id) { await waitFor(`!!document.querySelector('[data-provider-section="${id}"]')`, 'tab ' + id); await js(`document.querySelector('[data-provider-section="${id}"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))`); await sleep(150) }
async function click(code) { await waitFor(`!!(${code}) && !(${code}).disabled`, 'clickable ' + code.slice(0, 80)); await js(`(${code}).click()`); await sleep(120) }
async function type(selector, value) {
  await js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await sleep(60)
}
async function shot(name) { await sleep(300); fs.writeFileSync(path.join(output, name), (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG()) }
const cards = `[...document.querySelectorAll('h3')].map(el => el.textContent.trim())`
const calls = 'window.providersQA.calls()'
app.whenReady().then(async () => {
  window = new BrowserWindow({ show: false, width: 1360, height: 900, webPreferences: { offscreen: true, preload: path.join(root, 'tests/renderer/fixtures/providers-preload.cjs'), contextIsolation: true, backgroundThrottling: false, additionalArguments: process.argv.filter(arg => arg.startsWith('--providers-qa')) } })
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3 && !message.includes('Content Security Policy')) errors.push(message) })
  await window.loadFile(path.join(root, 'out/renderer/index.html'), { hash: '/providers' })
  await waitFor(`!!document.querySelector('[data-provider-section="web"]')`, 'provider tabs')
  await js(`localStorage.removeItem('dailyworkmate.providers.section')`)
  assert.deepEqual(await js(cards), ['DeepSeek'], 'web tab lists web providers only; Ollama nodes stay on their page')
  assert.match(await js(`document.querySelector('[data-provider-section="api"]').textContent`), /Official APIs · 0/)

  await tab('api')
  await waitFor(`document.body.textContent.includes('No official APIs yet')`, 'API empty state')
  await shot('providers-api-empty.png')
  await click(button('Add official API'))
  await waitFor(`!!document.querySelector('[data-api-preset="deepseek"]')`, 'preset grid')
  for (const id of ['openai', 'anthropic', 'gemini', 'deepseek', 'zhipu', 'moonshot', 'qwen', 'minimax', 'xai', 'openai-compatible']) assert.ok(await js(`!!document.querySelector('[data-api-preset="${id}"]')`), id)
  await shot('providers-api-presets.png')

  // A rejected key keeps the form open with the vendor's message.
  await click(`document.querySelector('[data-api-preset="deepseek"]')`)
  await waitFor(`!!document.querySelector('#api-key')`, 'key form')
  await click(button('Get an API key'))
  assert.equal((await js(calls)).at(-1).url, 'https://platform.deepseek.com/api_keys')
  await type('#api-key', 'sk-bad')
  await click(button('Verify and add'))
  await waitFor(`!!document.querySelector('[role="dialog"] [role="alert"]')`, 'key error')
  assert.match(await js(`document.querySelector('[role="dialog"] [role="alert"]').textContent`), /^The API key was rejected \(HTTP 401\): Authentication Fails/)

  await type('#api-key', 'sk-good-1234')
  await shot('providers-api-key.png')
  await click(button('Verify and add'))
  await waitFor(`!document.querySelector('[role="dialog"]') && ${cards}.includes('DeepSeek')`, 'API provider added')
  assert.deepEqual((await js(calls)).filter(call => call.operation === 'addApiProvider').at(-1).input, { presetId: 'deepseek', regionId: 'global', apiKey: 'sk-good-1234' })
  await waitFor(`document.body.textContent.includes('Added DeepSeek') && document.body.textContent.includes('3 models available') && document.body.textContent.includes('deepseek-v4-flash')`, 'added toast names models shared with the web provider')
  assert.match(await js(`document.querySelector('[data-provider-section="api"]').textContent`), /Official APIs · 1/)
  assert.ok(await js(`[...document.querySelectorAll('h3')].some(el => el.textContent.trim() === 'DeepSeek' && el.parentElement.textContent.includes('API'))`), 'card shows the API badge')
  assert.ok(await js(`document.body.textContent.includes('API Key') && document.body.textContent.includes('api.deepseek.com')`))
  await shot('providers-api-list.png')

  // The vendor already set up: the dialog says so and adds the key to it.
  await click(button('Add official API'))
  await waitFor(`!!document.querySelector('[data-api-preset="deepseek"]')`, 'preset grid again')
  assert.match(await js(`document.querySelector('[data-api-preset="deepseek"]').textContent`), /Added/)
  await click(`document.querySelector('[data-api-preset="deepseek"]')`)
  await waitFor(`document.querySelector('[role="dialog"]').textContent.includes('Already set up')`, 'existing vendor notice')
  await type('#api-key', 'sk-second')
  await click(button('Verify and add'))
  await waitFor(`document.body.textContent.includes('Added another API key to DeepSeek')`, 'second key added')

  await tab('web')
  await waitFor(`${cards}.length === 1`, 'back to web tab')
  await window.reload()
  await waitFor(`!!document.querySelector('[data-provider-section="api"][data-state="inactive"]')`, 'tab choice survives reload')
  assert.deepEqual(errors, [])
  console.log('PASS: separate web/API tabs, Ollama nodes excluded, preset grid, key link, rejected key message, add and add-another-key with shared-model notice')
}).catch(async error => { console.error(error); if (window) await shot('providers-ui-failure.png').catch(() => {}); process.exitCode = 1 }).finally(() => app.exit(process.exitCode || 0))
