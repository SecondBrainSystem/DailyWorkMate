// Run after npm run build: node_modules/electron/dist/electron.exe scripts/check-chat-ui.cjs
// Uses hidden windows, an isolated profile, a local mock server and no real accounts.
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const output = path.join(root, 'tmp', 'qa')
const rendererEntry = process.env.CHAT_QA_RENDERER || path.join(root, 'out/renderer/index.html')
fs.mkdirSync(output, { recursive: true })
app.setPath('userData', path.join(output, `chat-ui-profile-${process.pid}`))
app.disableHardwareAcceleration()
const requests = []
const requestHeaders = []
let availableModels = ['qwen3-vl:qa', 'qwen3:8b']
const errors = []
const results = []
let window
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-DailyWorkMate-Model-Selection, X-Refresh-Free-Models')
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return }
  if (req.url === '/v1/models') {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ data: availableModels.map(id => ({ id, owned_by: 'QA node' })) }))
    return
  }
  let raw = ''
  req.setEncoding('utf8')
  for await (const chunk of req) raw += chunk
  const body = JSON.parse(raw)
  if (req.url === '/v1/models/verify') {
    const recovered = !availableModels.includes(body.model)
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ model: recovered ? availableModels[0] : body.model, verified: true, recovered, providerName: 'QA node' }))
    return
  }
  requests.push(body)
  requestHeaders.push(req.headers)
  res.setHeader('Content-Type', 'text/event-stream')
  const text = JSON.stringify(body.messages.at(-1).content)
  const emit = content => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`)
  if (text.includes('UPSTREAM_FAILURE_QA')) {
    emit('PARTIAL_TRANSLATION_QA')
    res.end('data: {"error":{"message":"Node QA connection timed out"}}\n\n')
  } else if (text.includes('LONG_STREAM_QA')) {
    let step = 0
    const timer = setInterval(() => {
      res.write(': still processing\n\n')
      if (++step === 10) { clearInterval(timer); emit('LONG_STREAM_COMPLETE'); res.end('data: [DONE]\n\n') }
    }, 650)
    res.once('close', () => clearInterval(timer))
  } else if (text.includes('pending')) {
    emit('Pending response')
    const timeout = setTimeout(() => { emit('STALE RESPONSE'); res.end('data: [DONE]\n\n') }, 1800)
    res.once('close', () => clearTimeout(timeout))
  } else {
    emit('QA answer')
    res.write('data: [DONE]\n\n')
    // Deliberately keep HTTP open to exercise the SSE terminal marker handling.
    const timeout = setTimeout(() => res.end(), 2500)
    res.once('close', () => clearTimeout(timeout))
  }
})
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const js = async code => {
  let timer
  try {
    return await Promise.race([
      window.webContents.executeJavaScript(code, true),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Renderer evaluation timed out')), 15000) }),
    ])
  } catch (error) { throw new Error(error.message + '\nExpression: ' + code.slice(0, 400)) }
  finally { clearTimeout(timer) }
}
async function waitFor(code, label) {
  fs.appendFileSync(path.join(output, 'chat-ui-progress.log'), label + '\n')
  for (let i = 0; i < 240; i++) {
    if (await js(code)) return
    await delay(50)
  }
  throw new Error(`Timed out: ${label}`)
}
async function click(code) {
  const point = await js(`(() => { const el = (${code}); if (!el) throw new Error('Missing control'); el.scrollIntoView({block:'nearest'}); const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) }; })()`)
  window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
  window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
  await delay(70)
}
const button = text => `[...document.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(text)})`
const ready = `!!document.querySelector('[data-chat-ready="true"]') && ![...document.querySelectorAll('button')].find(el => el.title === 'Refresh models')?.disabled`
const backup = `JSON.parse(localStorage.getItem('dailyworkmate.chat.workspace.v1'))`
const row = id => `document.querySelector('[data-conversation-id="${id}"]')`
async function historyRows() {
  await click(button('History'))
  await waitFor(`!!document.querySelector('[role="dialog"]') && document.querySelector('[aria-busy="false"]') !== null`, 'history loaded')
}
async function closeHistory() {
  if (!await js(`!!document.querySelector('[role="dialog"]')`)) return
  await js(`document.querySelector('[role="dialog"]').dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true }))`)
  await waitFor(`!document.querySelector('[role="dialog"]')`, 'history closed')
}
async function newChat() {
  const id = await js(`${backup}.conversationId`)
  await click(button('New chat'))
  await waitFor(`${ready} && ${backup}.conversationId !== ${JSON.stringify(id)}`, 'new conversation saved')
}
async function clearChat(answer = 'Confirm') {
  await click(button('Clear chat'))
  await waitFor(`!!document.querySelector('[role="dialog"]')`, 'clear confirmation opened')
  if (answer === 'Escape') window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  else await click(`[...document.querySelectorAll('[role="dialog"] button')].find(el => el.textContent.trim() === ${JSON.stringify(answer)})`)
  await waitFor(`${ready} && !document.querySelector('[role="dialog"]') && getComputedStyle(document.body).pointerEvents !== 'none'`, 'clear confirmation released input')
}
async function typeWithKeyboard(text) {
  // Sending real Chromium input catches lost focus and leftover modal locks;
  // setting textarea.value + dispatchEvent can pass while the UI is unusable.
  await click(`document.querySelector('textarea')`)
  const before = await js(`document.querySelector('textarea').value`)
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'End', modifiers: ['control'] })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'End', modifiers: ['control'] })
  for (const character of text) window.webContents.sendInputEvent({ type: 'char', keyCode: character })
  await waitFor(`document.querySelector('textarea').value === ${JSON.stringify(before + text)}`, 'keyboard input after dialog')
  assert.equal(await js(`document.activeElement === document.querySelector('textarea')`), true)
}
async function readHistoryRecord(id) {
  return js(`new Promise((resolve, reject) => { const open = indexedDB.open('dailyworkmate.chat.history.v1'); open.onerror = () => reject(open.error); open.onsuccess = () => { const db = open.result; const request = db.transaction('conversations').objectStore('conversations').get(${JSON.stringify(id)}); request.onsuccess = () => { resolve(request.result || null); db.close() }; request.onerror = () => { reject(request.error); db.close() } } })`)
}
async function screenshot(name) {
  // Hidden offscreen windows can return a cached frame after navigation or resize.
  await js(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
  window.webContents.invalidate()
  await delay(150)
  fs.writeFileSync(path.join(output, name), (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG())
}
async function typeMessage(text) {
  await js(`(() => { const el = document.querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input', {bubbles:true})); el.focus(); })()`)
  await delay(40)
}
async function selectFeature(label, value) {
  await click(`document.getElementById([...document.querySelectorAll('label')].find(el => el.textContent === ${JSON.stringify(label)}).htmlFor)`)
  await waitFor(`document.querySelector('[role="option"]') !== null`, 'select options')
  await click(`[...document.querySelectorAll('[role="option"]')].find(el => el.textContent.trim() === ${JSON.stringify(value)})`)
}

async function run() {
  fs.writeFileSync(path.join(output, 'chat-ui-progress.log'), '')
  await app.whenReady()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  window = new BrowserWindow({ show: false, width: 1360, height: 940, webPreferences: {
    preload: path.join(root, 'tests/renderer/fixtures/chat-preload.cjs'),
    additionalArguments: [`--chat-qa-port=${server.address().port}`, '--chat-qa-seed-legacy'],
    contextIsolation: true, sandbox: false, backgroundThrottling: false, offscreen: true,
  } })
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3 && !message.includes('Content Security Policy')) errors.push(message) })
  await window.loadFile(rendererEntry, { hash: '/chat' })
  await waitFor(ready, 'chat loaded')
  await js('window.confirm = () => { throw new Error("Native synchronous confirmation must not be used") }; void 0')
  const legacyId = await js(`${backup}.conversationId`)
  assert.equal((await readHistoryRecord(legacyId)).messages.length, 120)
  assert.equal(await js(`document.querySelector('textarea').value`), 'Legacy draft')
  results.push('Legacy workspace migrates automatically into native IndexedDB with all 120 messages and its draft')
  await typeMessage('pending first')
  await click(`document.querySelector('button[title="Send"]')`)
  await waitFor(`document.body.innerText.includes('Pending response')`, 'stream running')
  await newChat()
  assert.equal(await js(`document.querySelector('textarea').value`), '')
  assert.deepEqual(await js(`JSON.parse(localStorage.getItem('dailyworkmate.chat.workspace.v1')).messages`), [])
  await typeMessage('second request')
  await click(`document.querySelector('button[title="Send"]')`)
  await waitFor(`document.body.innerText.includes('QA answer') && !document.querySelector('button[title="Stop generation"]')`, 'DONE stops generation')
  assert.equal(requests.at(-1).messages.length, 1)
  await delay(1900)
  assert.equal(await js(`document.body.innerText.includes('STALE RESPONSE')`), false)
  results.push('New chat aborts streaming; old callbacks cannot affect the next request; DONE releases UI before HTTP close')

  await clearChat()
  await typeWithKeyboard('draft only')
  const beforeCancel = await js(`${backup}.conversationId`)
  await clearChat('Cancel')
  assert.equal(await js(`${backup}.conversationId`), beforeCancel)
  assert.equal(await js(`document.querySelector('textarea').value`), 'draft only')
  await typeWithKeyboard(' after cancel')
  await clearChat('Escape')
  await typeWithKeyboard(' after escape')
  for (let i = 0; i < 3; i++) { await clearChat(); await typeWithKeyboard('repeat ' + i) }
  await clearChat()
  assert.equal(await js(`document.querySelector('textarea').value`), '')
  results.push('Real keyboard input survives repeated clear confirmations, cancellation and Escape; modal input locks are released')
  await window.reload()
  await waitFor(ready, 'reload')
  assert.equal(await js(`document.body.innerText.includes('QA answer')`), false)
  results.push('Clear resets messages and drafts, saves synchronously and remains clear after reload')

  await typeMessage('中文输入')
  const count = requests.length
  await js(`document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', code:'Enter', isComposing:true, bubbles:true }))`)
  await delay(150)
  assert.equal(requests.length, count)
  results.push('IME composition Enter does not send')
  await selectFeature('Think', 'Off')
  await selectFeature('Vision', 'Off')
  await click(`document.querySelector('button[title="Send"]')`)
  await waitFor(`document.body.innerText.includes('QA answer') && !document.querySelector('button[title="Stop generation"]')`, 'feature request')
  assert.equal(requests.at(-1).enable_thinking, false)
  assert.equal(requests.at(-1).enable_vision, false)
  results.push('Chat sends explicit thinking and vision off flags')

  await click(`document.querySelector('[role="combobox"][aria-label="Select a model"]')`)
  await waitFor(`!!document.querySelector('[role="option"]')`, 'model options')
  await click(`[...document.querySelectorAll('[role="option"]')].find(el => el.textContent.includes('qwen3:8b'))`)
  await typeMessage('Use the newly selected model')
  await click(`document.querySelector('button[title="Send"]')`)
  await waitFor(`!document.querySelector('button[title="Stop generation"]')`, 'changed model response')
  assert.equal(requests.at(-1).model, 'qwen3:8b')
  assert.equal(requestHeaders.at(-1)['x-dailyworkmate-model-selection'], 'explicit')
  results.push('Changing the visible model changes the request model and sends the explicit-selection routing marker')

  await newChat()
  await selectFeature('Think', 'On')
  await selectFeature('Vision', 'On')
  await click(`[...document.querySelectorAll('button')].find(el => el.textContent.includes('QA task') && el.textContent.includes('Test task'))`)
  await typeMessage('Saved attachment draft')
  await js(`(() => { const transfer = new DataTransfer(); transfer.items.add(new File([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXn8AAAAASUVORK5CYII='), c => c.charCodeAt(0))], 'history.png', {type:'image/png'})); const input = document.querySelector('input[type="file"]'); input.files = transfer.files; input.dispatchEvent(new Event('change', {bubbles:true})); })()`)
  await waitFor(`document.body.innerText.includes('history.png') && !document.querySelector('button[title="Send"]').disabled`, 'image attached')
  const draftId = await js(`${backup}.conversationId`)
  await newChat()
  const savedDraft = await readHistoryRecord(draftId)
  assert.equal(savedDraft.draft, 'Saved attachment draft')
  assert.equal(savedDraft.draftAttachments[0].name, 'history.png')
  assert.equal(savedDraft.systemPrompt, 'Summarize clearly.')
  await historyRows()
  await click(`${row(draftId)}.querySelector('button')`)
  await waitFor(`${ready} && document.querySelector('textarea').value === 'Saved attachment draft'`, 'draft restored')
  await window.reload()
  await waitFor(ready, 'saved draft reload')
  assert.equal(await js(`document.querySelector('textarea').value`), 'Saved attachment draft')
  assert.equal(await js(`document.body.innerText.includes('history.png')`), true)
  await click(`document.querySelector('button[title="Send"]')`)
  await waitFor(`document.body.innerText.includes('QA answer') && !document.querySelector('button[title="Stop generation"]')`, 'saved draft sent')
  assert.equal(requests.at(-1).model, 'qwen3:8b')
  assert.equal(requests.at(-1).enable_thinking, true)
  assert.equal(requests.at(-1).enable_vision, true)
  assert.deepEqual(requests.at(-1).messages[0], { role: 'system', content: 'Summarize clearly.' })
  assert.equal(requests.at(-1).messages[1].content[1].type, 'image_url')
  results.push('History restores drafts, images, task text, model and feature settings after reload, then sends them intact')

  await click(`document.querySelector('[data-task="free"]')`)
  await waitFor(`${ready} && ${backup}.promptId === ''`, 'free chat scope')
  await typeMessage('pending history switch')
  await click(`document.querySelector('button[title="Send"]')`)
  await waitFor(`document.body.innerText.includes('Pending response')`, 'stream before history switch')
  await historyRows()
  await click(`${row(legacyId)}.querySelector('button')`)
  await waitFor(`${ready} && ${backup}.conversationId === ${JSON.stringify(legacyId)}`, 'legacy conversation loaded')
  assert.equal((await readHistoryRecord(legacyId)).messages.length, 122)
  await delay(1900)
  assert.equal(await js(`document.body.innerText.includes('STALE RESPONSE')`), false)
  assert.equal(await js(`!!document.querySelector('button[title="Stop generation"]')`), false)
  results.push('Switching to history during generation aborts the previous stream and ignores late output')
  await typeMessage('Continue the old conversation')
  await click(`document.querySelector('button[title="Send"]')`)
  await waitFor(`!document.querySelector('button[title="Stop generation"]')`, 'continued history response')
  assert.equal(requests.at(-1).model, 'qwen3-vl:qa')
  assert.equal(requests.at(-1).messages.length, 123)
  assert.equal(requests.at(-1).messages[0].content, 'Legacy local conversation')
  results.push('Loading and continuing a previous conversation retains all turns and restores that conversation’s model')

  await typeMessage('Draft survives failed switch')
  await js(`window.qaTransaction = IDBDatabase.prototype.transaction; IDBDatabase.prototype.transaction = function(stores, mode, options) { if (mode === 'readwrite') throw new DOMException('QA simulated storage failure', 'QuotaExceededError'); return window.qaTransaction.call(this, stores, mode, options) }; void 0`)
  await click(button('New chat'))
  await waitFor(`${ready} && document.body.innerText.includes('Cannot save local data') && [...document.querySelectorAll('[role="alert"] details span')].some(el => el.textContent.includes('Unable to save or load the conversation'))`, 'failed transaction reported with recoverable details')
  assert.equal(await js(`document.querySelector('textarea').value`), 'Draft survives failed switch')
  const recoveredId = await js(`${backup}.conversationId`)
  assert.notEqual(recoveredId, legacyId, 'A new conversation remains usable when history storage fails')
  assert.ok((await readHistoryRecord(legacyId)).messages.length >= 122, 'The old conversation is retained')
  await js(`IDBDatabase.prototype.transaction = window.qaTransaction; delete window.qaTransaction`)
  await newChat()
  assert.equal((await readHistoryRecord(recoveredId)).draft, 'Draft survives failed switch')
  results.push('Failed history writes preserve the draft and previous history while allowing a new conversation')

  await click(`[...document.querySelectorAll('button')].find(el => el.textContent.includes('QA task') && el.textContent.includes('Test task'))`)
  await waitFor(`${ready} && ${backup}.promptId === 'qa-prompt'`, 'task scope restored')
  assert.ok(await js(`document.body.innerText.includes('Saved attachment draft')`))
  await historyRows()
  assert.equal(await js(`${row(legacyId)} !== null`), true, 'All tasks remain visible and are labeled in history')
  await js(`(() => { const input = document.querySelector('[role="dialog"] input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Saved attachment'); input.dispatchEvent(new Event('input', {bubbles:true})); })()`)
  await waitFor(`document.querySelectorAll('[data-conversation-id]').length === 1`, 'search filters history')
  assert.ok(await js(`${row(draftId)} !== null`))
  for (const width of [1360, 390]) {
    window.setSize(width, 940)
    if (width < 768) await waitFor(`document.querySelector('aside').getBoundingClientRect().width <= 74`, 'history narrow sidebar transition')
    await delay(650)
    const bounds = await js(`(() => { const d = document.querySelector('[role="dialog"]'); const r = d.getBoundingClientRect(); return {left:r.left, right:r.right, viewport:innerWidth, client:d.clientWidth, scroll:d.scrollWidth}; })()`)
    assert.ok(bounds.left >= 0 && bounds.right <= bounds.viewport && bounds.scroll <= bounds.client + 1, JSON.stringify(bounds))
    await screenshot(`chat-history-${width}.png`)
  }
  window.setSize(1360, 940)
  await click(`${row(draftId)}.querySelector('button[aria-label^="Delete"]')`)
  await click(button('Delete'))
  await waitFor(`${row(draftId)} === null`, 'archived conversation deleted')
  assert.equal(await readHistoryRecord(draftId), null)
  await closeHistory()
  await window.reload()
  await waitFor(ready, 'reload after delete')
  assert.equal(await readHistoryRecord(draftId), null)
  results.push('History search and responsive dialog work; deleting an archived chat survives reload without reviving it')

  await click(`document.querySelector('[data-task="free"]')`)
  await waitFor(`${ready} && ${backup}.promptId === ''`, 'free scope before deletion')
  await historyRows()
  await click(`${row(legacyId)}.querySelector('button')`)
  await waitFor(`${ready} && ${backup}.conversationId === ${JSON.stringify(legacyId)}`, 'active chat loaded for deletion')
  await historyRows()
  await click(`${row(legacyId)}.querySelector('button[aria-label^="Delete"]')`)
  await click(button('Delete'))
  await waitFor(`${ready} && ${backup}.conversationId !== ${JSON.stringify(legacyId)}`, 'active chat deleted')
  assert.equal(await readHistoryRecord(legacyId), null)
  assert.deepEqual(await js(`${backup}.messages`), [])
  results.push('Deleting the active conversation selects a new blank conversation atomically')

  availableModels = ['qwen3:8b']
  await click(`document.querySelector('button[title="Refresh models"]')`)
  await waitFor(`!document.querySelector('button[title="Refresh models"]').disabled`, 'refresh missing model')
  assert.ok(await js(`document.querySelector('[role="combobox"][aria-label="Select a model"]').textContent.includes('qwen3-vl:qa')`))
  await typeMessage('Unavailable model must preserve my selection')
  const requestsBeforeUnavailable = requests.length
  assert.equal(await js(`document.querySelector('button[title="Send"]').disabled`), false)
  await click(`document.querySelector('button[title="Send"]')`)
  await waitFor(`!document.querySelector('button[title="Stop generation"]') && !!document.querySelector('[role="alert"]')`, 'unavailable model reported')
  assert.equal(await js(`${backup}.model`), 'qwen3-vl:qa')
  assert.equal(requests.length, requestsBeforeUnavailable, 'Verification cannot substitute an unrelated model')
  assert.ok(await js(`document.querySelector('[role="combobox"][aria-label="Select a model"]').textContent.includes('qwen3-vl:qa')`))
  await click(`document.querySelector('[role="combobox"][aria-label="Select a model"]')`)
  await waitFor(`!!document.querySelector('[role="option"]')`, 'manual replacement options')
  await click(`[...document.querySelectorAll('[role="option"]')].find(el => el.textContent.includes('qwen3:8b'))`)
  availableModels = ['qwen3-vl:qa', 'qwen3:8b']
  await click(`document.querySelector('button[title="Refresh models"]')`)
  await waitFor(ready, 'models restored')
  results.push('Unavailable or mismatched verification cannot replace the selected model; a different model requires an explicit selection')
  window.webContents.debugger.attach('1.3')
  const accessibility = await window.webContents.debugger.sendCommand('Accessibility.getFullAXTree')
  for (const node of accessibility.nodes.filter(node => node.role?.value === 'combobox' && !node.ignored)) {
    assert.ok(node.name?.value?.trim(), 'Visible combobox has an accessible name')
  }
  window.webContents.debugger.detach()
  results.push('Rendered model, task and feature comboboxes have accessible names')

  await newChat()
  const longInput = '长文本内容。'.repeat(20000) + 'LONG_INPUT_END'
  await typeMessage(longInput)
  await click(`document.querySelector('button[title="Send"]')`)
  await waitFor(`!document.querySelector('button[title="Stop generation"]')`, 'long input sent intact')
  assert.ok(requests.at(-1).messages.at(-1).content === longInput, 'Long input must arrive unchanged')
  await typeMessage('LONG_STREAM_QA')
  await click(`document.querySelector('button[title="Send"]')`)
  await waitFor(`document.body.innerText.includes('LONG_STREAM_COMPLETE') && !document.querySelector('button[title="Stop generation"]')`, 'active stream survives overall timeout')
  results.push('Long input is not truncated; a healthy stream outlives the configured timeout while heartbeats continue')

  await typeMessage('UPSTREAM_FAILURE_QA')
  await click(`document.querySelector('button[title="Send"]')`)
  await waitFor(`!!document.querySelector('[role="alert"]') && !document.querySelector('button[title="Stop generation"]')`, 'specific failure shown inline')
  assert.equal(await js(`document.querySelector('[role="alert"] details span').textContent`), 'Node QA connection timed out')
  await waitFor(`${backup}.messages.at(-1).error === 'Node QA connection timed out'`, 'failure persisted')
  await window.reload()
  await waitFor(`${ready} && !!document.querySelector('[role="alert"]')`, 'specific failure restored')
  assert.ok(await js(`document.body.innerText.includes('PARTIAL_TRANSLATION_QA')`))
  assert.equal(await js(`document.querySelector('[role="alert"] details span').textContent`), 'Node QA connection timed out')
  results.push('Partial output and the actual upstream error remain together after reload')

  for (const theme of ['light', 'dark']) {
    await js(`document.documentElement.setAttribute('data-theme', '${theme}')`)
    for (const width of [1360, 520, 390]) {
      window.setSize(width, 940)
      if (width < 768) await waitFor(`document.querySelector('aside').getBoundingClientRect().width <= 74`, 'narrow sidebar transition')
      await delay(650)
      await js(`document.querySelector('main').scrollTop = 0`)
      const bounds = await js(`(() => { const m = document.querySelector('main'); return { client: m.clientWidth, scroll: m.scrollWidth }; })()`)
      assert.ok(bounds.scroll <= bounds.client + 1, `Horizontal overflow at ${width}: ${JSON.stringify(bounds)}`)
      await screenshot(`chat-${theme}-${width}.png`)
    }
  }
  results.push('Light/dark layouts at 1360px, 520px and 390px have no horizontal overflow; screenshots captured')
  window.setSize(1360, 940)
  await js(`location.hash = '/proxy'`)
  await waitFor(`!![...document.querySelectorAll('[role="tab"]')].find(el => el.textContent.includes('Basic'))`, 'proxy tabs')
  await click(`[...document.querySelectorAll('[role="tab"]')].find(el => el.textContent.includes('Basic'))`)
  await waitFor(`document.body.innerText.includes('Vision / Think defaults')`, 'proxy defaults')
  await selectFeature('Think', 'Off')
  await selectFeature('Vision', 'Off')
  await click(`[...document.querySelectorAll('button')].filter(el => el.textContent.trim() === 'Save').at(-1)`)
  await waitFor(`document.body.innerText.includes('Saved. Applies to new requests immediately.')`, 'defaults saved')
  assert.deepEqual(await js(`window.electronAPI.config.get().then(config => config.modelFeatureDefaults)`), { thinking: 'disabled', vision: 'disabled' })
  await delay(650)
  await screenshot('proxy-features.png')
  results.push('Proxy defaults save through the IPC config update path')

  // Translation tasks choose a target language; it is sent with the task prompt and saved with the chat.
  await js(`location.hash = '/chat'`)
  await waitFor(ready, 'chat for translation')
  await click(`document.querySelector('[data-task="free"]')`)
  await waitFor(`${ready} && !document.querySelector('[aria-label="Translation target language"]')`, 'free chat has no target picker')
  await click(`[...document.querySelectorAll('button')].find(el => el.textContent.includes('QA translation'))`)
  await waitFor(`${ready} && !!document.querySelector('[aria-label="Translation target language"]')`, 'translation target picker')
  await click(`document.querySelector('[aria-label="Translation target language"]')`)
  await waitFor(`!!document.querySelector('[role="option"]')`, 'target options')
  await click(`[...document.querySelectorAll('[role="option"]')].find(el => el.textContent.trim() === 'Deutsch')`)
  await waitFor(`document.querySelector('[aria-label="Translation target language"]').textContent.includes('Deutsch')`, 'Deutsch selected')
  const translationBefore = requests.length
  await typeMessage('Hello translation QA')
  await click(`document.querySelector('button[title="Send"]')`)
  for (const end = Date.now() + 20000; requests.length === translationBefore;) { if (Date.now() > end) throw new Error('Timed out: translation request'); await delay(50) }
  const translationRequest = requests.at(-1)
  assert.equal(translationRequest.messages[0].role, 'system')
  assert.match(translationRequest.messages[0].content, /^Translate faithfully\.\n\nTarget language: German \(Deutsch\)/)
  await waitFor(`!document.querySelector('button[title="Stop generation"]') && JSON.parse(localStorage.getItem('dailyworkmate.chat.workspace.v1')).translationTarget === 'de'`, 'target saved with the chat')
  // The task sidebar folds away; the task picker in the chat header takes over.
  await click(`document.querySelector('[aria-label="Collapse tasks"]')`)
  await waitFor(`!document.querySelector('[data-task="free"]')?.offsetParent && !!document.querySelector('[aria-label="Show tasks"]')`, 'task sidebar collapsed')
  await click(`document.querySelector('[aria-label="Show tasks"]')`)
  await waitFor(`!!document.querySelector('[data-task="free"]')?.offsetParent`, 'task sidebar shown')
  results.push('Translation target language is sent with the task prompt and saved; free chat has no picker; the task sidebar collapses')
  await click(`document.querySelector('header .lucide-languages').closest('button')`)
  await js(`location.hash = '/chat'`)
  await waitFor(`document.body.innerText.includes('新对话') && !!document.querySelector('[data-chat-ready="true"]')`, 'Chinese chat')
  await delay(650)
  await js(`document.querySelector('main').scrollTop = 0`)
  await screenshot('chat-zh-CN.png')
  await click(button('历史记录'))
  await waitFor(`!!document.querySelector('[role="dialog"]') && document.body.innerText.includes('记录保存在本机')`, 'Chinese history')
  await screenshot('chat-history-zh-CN.png')
  await closeHistory()
  await click(button('新对话'))
  // New chat persists asynchronously; wait for it instead of asserting after a fixed delay.
  await waitFor(`JSON.parse(localStorage.getItem('dailyworkmate.chat.workspace.v1')).messages.length === 0`, 'new chat cleared')
  results.push('Chinese controls render and New chat works')
  assert.deepEqual(errors, [])
}
run().then(() => {
  fs.writeFileSync(path.join(output, 'chat-ui-report.json'), JSON.stringify({ passed: true, results, errors }, null, 2))
  console.log(JSON.stringify({ passed: true, results }, null, 2))
  server.closeAllConnections(); server.close(); window?.destroy(); app.exit(0)
}).catch(error => {
  fs.writeFileSync(path.join(output, 'chat-ui-report.json'), JSON.stringify({ passed: false, results, errors, error: error.stack }, null, 2))
  console.error(error)
  server.closeAllConnections(); server.close(); window?.destroy(); app.exit(1)
})
