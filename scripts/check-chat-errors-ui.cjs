// Uses a hidden window, isolated storage and localhost; no real provider is contacted.
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const output = path.join(root, 'tmp/qa')
const rendererEntry = process.env.CHAT_QA_RENDERER || path.join(root, 'out/renderer/index.html')
fs.mkdirSync(output, { recursive: true })
app.setPath('userData', path.join(output, 'chat-errors-profile-' + process.pid))
app.disableHardwareAcceleration()
let window
let mode = 'failure'
const requests = []
const results = []
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-DailyWorkMate-Model-Selection')
  if (req.method === 'OPTIONS') return res.writeHead(204).end()
  if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'qwen3:8b' }] }))
  let raw = ''
  for await (const chunk of req) raw += chunk
  if (req.url === '/v1/models/verify') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ model: JSON.parse(raw).model, verified: true, recovered: false })) }
  requests.push(JSON.parse(raw))
  if (mode === 'failure') {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ error: { message: 'QA upstream failure' } }))
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  res.flushHeaders()
  if (mode === 'pending') return
  res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Actual answer' } }] }) + '\n\n')
  if (mode === 'partial-error') return res.end('data: {"error":{"message":"QA interrupted"}}\n\n')
  res.end('data: [DONE]\n\n')
})
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const js = code => window.webContents.executeJavaScript(code, true)
async function waitFor(code, label) {
  for (let i = 0; i < 100; i++) { if (await js(code)) return; await delay(50) }
  throw new Error('Timed out: ' + label)
}
const ready = '!!document.querySelector("[data-chat-ready=true]") && !!document.querySelector("button[title=Send]") && !document.querySelector("button[title=Send]").disabled'
async function type(text) {
  await js('(() => { const el = document.querySelector("textarea"); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, ' + JSON.stringify(text) + '); el.dispatchEvent(new Event("input", {bubbles:true})); })()')
  await delay(60)
}
async function click(title) { await js('document.querySelector(' + JSON.stringify('button[title="' + title + '"]') + ').click()'); await delay(60) }
async function send(text) {
  await type(text)
  await waitFor(ready, 'send enabled')
  await click('Send')
  await waitFor('!document.querySelector("button[title=\\"Stop generation\\"]")', 'generation ended')
}
async function run() {
  await app.whenReady()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  window = new BrowserWindow({ show: false, width: 1300, height: 900, webPreferences: {
    preload: path.join(root, 'tests/renderer/fixtures/chat-preload.cjs'),
    additionalArguments: ['--chat-qa-port=' + server.address().port],
    sandbox: false, contextIsolation: true, backgroundThrottling: false, offscreen: true,
  } })
  await window.loadFile(rendererEntry, { hash: '/chat' })
  await waitFor('!!document.querySelector("[data-chat-ready=true]")', 'chat ready')
  await send('first fails')
  await waitFor('document.body.innerText.includes("QA upstream failure")', 'failure visible')
  mode = 'success'
  await send('follow up')
  fs.writeFileSync(path.join(output, 'chat-error-context-payload.json'), JSON.stringify(requests.at(-1), null, 2))
  assert.deepEqual(requests.at(-1).messages.filter(m => m.role === 'assistant'), [])
  results.push('Empty failed responses stay visible without entering subsequent model context')
  mode = 'pending'
  await type('please stop')
  await click('Send')
  await waitFor('!!document.querySelector("button[title=\\"Stop generation\\"]")', 'pending')
  await delay(100)
  await click('Stop generation')
  await waitFor('!document.querySelector("button[title=\\"Stop generation\\"]")', 'stopped')
  await delay(800)
  await window.reload()
  await waitFor('!!document.querySelector("[data-chat-ready=true]")', 'reload ready')
  mode = 'success'
  await send('after reload')
  assert.deepEqual(requests.at(-1).messages.filter(m => m.role === 'assistant').map(m => m.content), ['Actual answer'])
  results.push('Stopped empty responses retain their UI status after reload without entering context')
  mode = 'partial-error'
  await send('partial')
  mode = 'success'
  await send('continue partial')
  assert.deepEqual(requests.at(-1).messages.filter(m => m.role === 'assistant').map(m => m.content), ['Actual answer', 'Actual answer', 'Actual answer'])
  results.push('A failed response preserves its genuine partial content for follow-up')
}
function finish(error) {
  fs.writeFileSync(path.join(output, 'chat-errors-ui-report.json'), JSON.stringify({ passed: !error, results, error: error?.stack }, null, 2))
  if (error) console.error(error)
  else console.log(JSON.stringify({ passed: true, results }, null, 2))
  server.closeAllConnections(); server.close(); window?.destroy(); app.exit(error ? 1 : 0)
}
run().then(() => finish(), finish)
