// Run after npm run build with Electron, not Node:
// node_modules/electron/dist/electron.exe scripts/check-workspace-chat-ui.cjs
// Both real renderer pages submit through IPC into an isolated, deterministic
// agent. Only files created below this script's scratch directory are accessed.
const { app, BrowserWindow, ipcMain } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { execFileSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const output = path.join(root, 'tmp')
fs.mkdirSync(output, { recursive: true })
const scratch = fs.mkdtempSync(path.join(output, 'workspace-chat-ui-'))
const workspace = path.join(scratch, 'workspace')
const otherWorkspace = path.join(scratch, 'other-workspace')
for (const folder of [workspace, otherWorkspace]) fs.mkdirSync(path.join(folder, 'docs'), { recursive: true })
fs.writeFileSync(path.join(workspace, 'hello.txt'), 'WORKSPACE_CHAT_READ_CONTENT')
fs.writeFileSync(path.join(workspace, 'docs', 'inside.txt'), 'WORKSPACE_CHAT_SUBFOLDER_CONTENT')
fs.writeFileSync(path.join(otherWorkspace, 'hello.txt'), 'WORKSPACE_CHAT_OTHER_CONTENT')
app.setPath('userData', path.join(scratch, 'profile'))
app.disableHardwareAcceleration()

const calls = [], requests = [], results = [], errors = [], commandExecutions = [], sessions = new Map()
let window, config, snapshot, job, agentSerial = 0, shuttingDown = false
let freeCatalogueStale = false, proxyCatalogueUnavailable = false
let kiloCatalogueStale = false
let workspacePickerOutcome = 'cancel'
const kiloId = 'kilo-free/qa/model:free'
let agent = { sessionId: '', running: false, text: '', error: '', tools: [], permissions: [] }
const prompt = { id: 'qa-prompt', name: 'QA workspace task', description: '', emoji: '', prompt: 'QA_SYSTEM_PROMPT: inspect the selected authorized workspace.', type: 'system', createdAt: 0, updatedAt: 0 }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const record = (operation, args) => { const entry = { operation, args: structuredClone(args), at: Date.now() }; calls.push(entry); return entry }
const starts = () => calls.filter(call => call.operation === 'companion:startAgent')
const proxyRequests = () => requests.filter(request => request.url === '/v1/chat/completions')

const server = http.createServer(async (req, res) => {
  try {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-DailyWorkMate-Model-Selection, X-Refresh-Free-Models')
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return }
    if (req.url === '/v1/models') { res.setHeader('Content-Type', 'application/json'); if (proxyCatalogueUnavailable) { res.writeHead(503).end('{}'); return }; res.end(JSON.stringify({ data: [{ id: 'qa-model', owned_by: 'QA node' }, { id: 'qa-model-alt', owned_by: 'QA node' }, ...(!kiloCatalogueStale ? [{ id: kiloId, name: 'QA Kilo Free', owned_by: 'Kilo Free' }] : [])], kilo: { stale: kiloCatalogueStale, ...(kiloCatalogueStale ? { error: 'QA_KILO_CATALOGUE_UNAVAILABLE' } : {}) } })); return }
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    requests.push({ url: req.url, body, headers: req.headers })
    if (req.url === '/v1/models/verify') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ model: body.model, verified: true, recovered: false })); return }
    assert.equal(req.url, '/v1/chat/completions')
    res.setHeader('Content-Type', 'text/event-stream')
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'QA_PLAIN_CHAT_REPLY' } }] }) + '\n\n')
    res.end('data: [DONE]\n\n')
  } catch (error) { errors.push(error.message); res.writeHead(500).end(JSON.stringify({ error: { message: error.message } })) }
})

function selectedGrant(input) {
  const grant = snapshot.workspaces.find(item => item.id === input.workspaceId)
  assert.ok(grant, 'A selected grant must reach startAgent')
  if (input.groupId) assert.ok(snapshot.groups.find(item => item.id === input.groupId)?.workspaceIds.includes(grant.id), 'Group must contain the selected grant')
  if (input.accessScope === 'folder') assert.ok(input.relativePath && !input.relativePath.split(/[\\/]/).includes('..'), 'Subfolder requests must remain in scope')
  return grant
}
function sessionIdentity(input) {
  const group = snapshot.groups.find(item => item.id === input.groupId)
  const grants = group ? snapshot.workspaces.filter(item => group.workspaceIds.includes(item.id)) : input.workspaceId ? [selectedGrant(input)] : []
  return JSON.stringify({ workspaceId: input.workspaceId, groupId: input.groupId || '', accessScope: input.accessScope || 'group', relativePath: input.relativePath || '', model: input.model, systemPrompt: input.systemPrompt || '', grants })
}
function finishTask() {
  const current = job
  if (!current || !agent.running) return agent
  const grant = selectedGrant(current.input)
  const taskDirectory = current.input.accessScope === 'folder' ? path.join(grant.path, current.input.relativePath) : grant.path
  const suffix = current.surface
  let text, error = '', toolStatus = 'completed'
  if (current.action === 'READ') {
    const target = current.input.accessScope === 'folder' ? 'inside.txt' : 'hello.txt'
    text = 'QA_READ_' + suffix + '_COMPLETE: ' + fs.readFileSync(path.join(taskDirectory, target), 'utf8')
  } else if (current.action === 'WRITE') {
    if (!grant.writable) { error = 'QA_READ_ONLY_DENIED'; text = 'QA_WRITE_' + suffix + '_DENIED'; toolStatus = 'error' }
    else { const target = path.join(taskDirectory, 'written-' + suffix.toLowerCase() + '.txt'); fs.writeFileSync(target, 'QA_WRITE_' + suffix + '_CONTENT'); text = 'QA_WRITE_' + suffix + '_COMPLETE' }
  } else if (current.action === 'COMMAND') {
    if (!grant.writable || current.input.accessScope === 'folder') {
      error = 'QA_COMMAND_ACCESS_DENIED'; text = 'QA_COMMAND_' + suffix + '_DENIED'; toolStatus = 'error'
    } else {
      const filename = 'command-' + suffix.toLowerCase() + '-' + commandExecutions.length + '.txt'
      const content = 'QA_COMMAND_' + suffix + '_CONTENT'
      // Execute a deterministic command in the authorized QA directory, without
      // constructing a shell string or touching the user's application folders.
      execFileSync(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], process.argv[2])', filename, content], {
        cwd: taskDirectory, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 10000,
      })
      assert.equal(fs.readFileSync(path.join(taskDirectory, filename), 'utf8'), content)
      commandExecutions.push({ surface: suffix, directory: taskDirectory, filename })
      text = 'QA_COMMAND_' + suffix + '_COMPLETE'
    }
  } else if (current.action === 'NOTOOLS') text = 'QA_NO_TOOLS_' + suffix + '_REPLY'
  else if (current.action === 'ERROR') { text = ''; error = 'QA_AGENT_ERROR_' + suffix; toolStatus = 'error' }
  else throw new Error('Unknown test action: ' + current.action)
  agent = { ...agent, running: false, text, error, tools: agent.tools.map(tool => ({ ...tool, status: toolStatus })), permissions: [] }
  return agent
}

const operations = {
  'app:openExternal': async () => true,
  'config:get': async () => config,
  'config:update': async updates => { config = { ...config, ...updates }; return true },
  'store:get': async key => key === 'config' ? config : [],
  'store:set': async () => {},
  'proxy:getStatus': async () => ({ isRunning: true, port: server.address().port, host: '127.0.0.1', uptime: 1, connections: 0 }),
  'proxy:getModels': async () => [{ id: 'qa-model', owned_by: 'QA node' }, { id: 'qa-model-alt', owned_by: 'QA node' }],
  'proxy:start': async () => true,
  'proxy:stop': async () => true,
  'prompts:getAll': async () => [prompt],
  'prompts:update': async (_id, updates) => ({ ...prompt, ...updates }),
  'providers:getAll': async () => [],
  'providers:getEffectiveModels': async () => [],
  'accounts:getAll': async () => [],
  'statistics:get': async () => ({ dailyStats: {}, accountUsage: {} }),
  'companion:get': async () => snapshot,
  'companion:saveSettings': async settings => { snapshot = { ...snapshot, settings }; return snapshot },
  'companion:saveMessages': async messages => { snapshot = { ...snapshot, messages } },
  'companion:addWorkspace': async () => {
    await delay(150)
    if (workspacePickerOutcome === 'error') throw new Error('QA_PICKER_FAILED')
    if (workspacePickerOutcome === 'add') snapshot = { ...snapshot, workspaces: [...snapshot.workspaces, { id: 'qa-added', name: 'QA added folder', path: scratch, writable: false }] }
    return snapshot
  },
  'companion:updateWorkspace': async (id, writable) => { snapshot = { ...snapshot, workspaces: writable === null ? snapshot.workspaces.filter(item => item.id !== id) : snapshot.workspaces.map(item => item.id === id ? { ...item, writable } : item) }; return snapshot },
  'companion:saveWorkspaceGroup': async group => { snapshot = { ...snapshot, groups: [...snapshot.groups.filter(item => item.id !== group.id), { ...group, id: group.id || 'qa-group-new' }] }; return snapshot },
  'companion:deleteWorkspaceGroup': async id => { snapshot = { ...snapshot, groups: snapshot.groups.filter(item => item.id !== id) }; return snapshot },
  'companion:listFiles': async (id, relativePath = '') => {
    const grant = snapshot.workspaces.find(item => item.id === id); assert.ok(grant)
    assert.ok(!relativePath.split(/[\\/]/).includes('..'))
    return fs.readdirSync(path.join(grant.path, relativePath), { withFileTypes: true }).map(entry => ({ name: entry.name, relativePath: relativePath ? relativePath + '/' + entry.name : entry.name, directory: entry.isDirectory() }))
  },
  'companion:readFile': async (id, relativePath) => { const grant = snapshot.workspaces.find(item => item.id === id); assert.ok(grant); assert.ok(!relativePath.split(/[\\/]/).includes('..')); return fs.readFileSync(path.join(grant.path, relativePath), 'utf8') },
  'companion:startAgent': async input => {
    assert.equal(agent.running, false, 'Renderer must stop the prior task before starting a new task')
    assert.ok(['qa-model', 'qa-model-alt', 'opencode-free/qa-free', kiloId].includes(input.model))
    assert.equal(typeof input.prompt, 'string'); assert.ok(input.prompt.trim())
    assert.equal(typeof input.systemPrompt, 'string', 'The active Chat task / Companion persona must reach the agent')
    if (input.history) assert.ok(input.history.every(message => ['user', 'assistant'].includes(message.role) && typeof message.content === 'string'))
    const identity = sessionIdentity(input)
    if (input.sessionId) assert.equal(sessions.get(input.sessionId), identity, 'Renderer reused a native session after changing model, persona, folder scope or permissions')
    const sessionId = input.sessionId || 'v2:0123456789abcdef:qa-' + ++agentSerial
    sessions.set(sessionId, identity)
    if (!input.workspaceId) {
      assert.ok(input.prompt === 'PLAIN_COMPANION_QA: regular chat without filesystem tools' || input.model === kiloId || /^FREE_CHAT_(FIRST|FOLLOWUP|LIMIT|WAIT)_QA$/.test(input.prompt))
      assert.ok(!input.groupId && !input.relativePath, 'Ordinary chat must not inherit a prior workspace scope')
      job = undefined
      agent = { sessionId, running: input.prompt === 'FREE_CHAT_WAIT_QA', text: 'QA_PLAIN_CHAT_REPLY ' + input.prompt,
        error: input.prompt === 'FREE_CHAT_LIMIT_QA' ? 'HTTP 429: QA_FREE_RATE_LIMIT' : '', tools: [], permissions: [] }
      return agent
    }
    const grant = selectedGrant(input)
    const marker = input.prompt.match(/UI_(READ|WRITE|COMMAND|WAIT|NOTOOLS|ERROR)_(CHAT|COMPANION)_QA/)
    assert.ok(marker, 'Unexpected task: ' + input.prompt)
    job = { input: structuredClone(input), action: marker[1], surface: marker[2], polls: 0 }
    const name = marker[1] === 'WRITE' ? 'write' : marker[1] === 'COMMAND' ? 'shell' : 'read'
    const title = marker[1] === 'WRITE' ? 'written-' + marker[2].toLowerCase() + '.txt' : marker[1] === 'COMMAND' ? 'node -e write QA_WORKSPACE_COMMAND marker' : 'hello.txt'
    agent = { sessionId, running: true, text: 'QA_' + marker[2] + '_PARTIAL', error: '', tools: marker[1] === 'NOTOOLS' ? [] : [{ id: 'tool-' + agentSerial, name, status: 'running', title }], permissions: [] }
    if (marker[1] === 'WRITE' && !grant.writable) return finishTask()
    if (marker[1] === 'COMMAND' && (!grant.writable || input.accessScope === 'folder')) return finishTask()
    return agent
  },
  'companion:pollAgent': async () => {
    if (agent.running && job && job.action !== 'WAIT' && !agent.permissions.length && ++job.polls >= 2) finishTask()
    return agent
  },
  'companion:stopAgent': async () => { agent = { ...agent, running: false, permissions: [], tools: agent.tools.map(tool => ({ ...tool, status: 'cancelled' })) }; job = undefined },
  'companion:replyPermission': async () => { throw new Error('Authorized chat commands must not require a permission reply') },
  'companion:openCodeStatus': async () => ({ currentVersion: '2.0.23', latestVersion: '', checkedAt: 0, releaseUrl: '', updateAvailable: false, checking: false, installing: false, error: '', source: 'bundled' }),
  'companion:openCodeModels': async () => ({ models: [{ id: 'opencode-free/qa-free', apiModel: 'qa-free', name: 'QA Free Native', contextLimit: 128000, outputLimit: 16000, toolCall: true }], updatedAt: Date.now(), stale: freeCatalogueStale }),
  'companion:localSpeechStatus': async () => ({ available: true, recognitionAvailable: true, engine: 'sherpa-onnx', model: 'QA voice', fastAvailable: true, ready: true, warming: false, readyEngine: 'fast' }),
  'companion:warmupSpeech': async () => ({ available: true, recognitionAvailable: true, fastAvailable: true, ready: true, warming: false, readyEngine: 'fast' }),
  'companion:cancelSpeech': async () => {},
  'companion:synthesize': async () => { throw new Error('Speech is disabled in workspace-chat QA') },
  'companion:transcribe': async () => 'UI_READ_COMPANION_QA',
  'companion:pickAvatar': async () => snapshot,
  'companion:pickAvatarModel': async () => snapshot,
  'companion:resetAvatar': async () => snapshot,
  'companion:resetAvatarModel': async () => snapshot,
}
for (const [operation, handler] of Object.entries(operations)) ipcMain.handle('workspace-chat-qa:' + operation, async (event, ...args) => {
  if (shuttingDown) return undefined
  assert.equal(event.sender, window.webContents)
  record(operation, args)
  try { return await handler(...args) } catch (error) { if (error.message !== 'QA_PICKER_FAILED') errors.push(operation + ': ' + error.message); throw error }
})

const js = code => window.webContents.executeJavaScript(code, true)
const expandWorkspace = () => js(`document.querySelector('[data-workspace-toggle][aria-expanded="false"]')?.click()`)
const button = text => `[...document.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(text)} && el.getClientRects().length)`
async function wait(code, label, timeout = 25000) {
  fs.appendFileSync(path.join(scratch, 'progress.log'), label + '\n')
  const deadline = Date.now() + timeout
  while (!(await js(code))) { if (Date.now() >= deadline) throw new Error('Timed out: ' + label); await delay(80) }
}
async function click(code) { await wait(`!!(${code}) && !(${code}).disabled`, 'clickable ' + code.slice(0, 100)); await js(`(${code}).click()`); await delay(100) }
async function fill(surface, text) {
  const selector = surface === 'CHAT' ? '[data-chat-ready] textarea' : '.companion-composer textarea'
  await js(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) throw new Error('Missing composer'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(element,${JSON.stringify(text)}); element.dispatchEvent(new Event('input',{bubbles:true})); })()`)
  await delay(80)
}
async function selectWorkspace(value) {
  const selector = 'select[aria-label="Chat workspace"]'
  await expandWorkspace()
  await wait(`!!document.querySelector(${JSON.stringify(selector)})`, 'workspace selector')
  await js(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (![...element.options].some(option => option.value === ${JSON.stringify(value)})) throw new Error('Missing workspace option: ' + ${JSON.stringify(value)}); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(element,${JSON.stringify(value)}); element.dispatchEvent(new Event('change',{bubbles:true})); })()`)
  await wait(`document.querySelector(${JSON.stringify(selector)}).value === ${JSON.stringify(value)}`, 'selected ' + value)
  await delay(100)
}
const sendButton = surface => surface === 'CHAT' ? `document.querySelector('button[title="Send"]')` : button('Send')
const stopButton = surface => surface === 'CHAT' ? `document.querySelector('button[title="Stop generation"]')` : button('Stop')
const ready = surface => surface === 'CHAT' ? `!!document.querySelector('[data-chat-ready="true"]')` : `!!document.querySelector('[data-companion-ready="true"]')`
async function send(surface, action) {
  const before = starts().length, plainBefore = proxyRequests().length
  await fill(surface, 'UI_' + action + '_' + surface + '_QA: Use the current authorized folder.')
  await click(sendButton(surface))
  const deadline = Date.now() + 15000
  while (starts().length === before) { if (Date.now() > deadline) throw new Error(surface + ' Send did not use startAgent'); await delay(80) }
  assert.equal(proxyRequests().length, plainBefore, 'Workspace sends must use the file-capable agent')
  const input = starts().at(-1).args[0]
  assert.equal(input.workspaceId, 'qa-folder')
  assert.equal(input.model, 'qa-model')
  return input
}
async function finish(surface, text) { await wait(`document.body.innerText.includes(${JSON.stringify(text)}) && !(${stopButton(surface)})`, surface + ' response ' + text) }
async function setWritable(surface, writable) {
  await click(button('Manage access'))
  await wait(`!!document.querySelector('[role="dialog"] select[aria-label="QA workspace access"]')`, surface + ' grant dialog')
  const value = writable ? 'write' : 'read'
  await js(`(() => { const element = document.querySelector('select[aria-label="QA workspace access"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(element,${JSON.stringify(value)}); element.dispatchEvent(new Event('change',{bubbles:true})); })()`)
  await wait(`document.querySelector('select[aria-label="QA workspace access"]').value === ${JSON.stringify(value)}`, 'grant updated')
  await click(button('Close'))
  await wait(`!document.querySelector('[role="dialog"]')`, 'grant dialog closed')
  assert.equal(snapshot.workspaces.find(item => item.id === 'qa-folder').writable, writable)
}
async function screenshot(name) {
  await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  await delay(100)
  fs.writeFileSync(path.join(scratch, name + '.png'), (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG())
}
async function loadSurface(surface) {
  await window.loadFile(process.env.WORKSPACE_CHAT_QA_RENDERER || path.join(root, 'out/renderer/index.html'), { hash: surface === 'CHAT' ? '/chat' : '/' })
  await wait(ready(surface), surface + ' ready')
  await js('window.confirm = () => { throw new Error("Native synchronous confirmation must not be used") }; void 0')
}
async function selectChatModel(label) {
  // Radix Select opens on pointer-down, not a synthetic click.
  await js(`document.querySelector('[role="combobox"][aria-label="Select a model"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`)
  await click(`[...document.querySelectorAll('[role="option"]')].find(element => element.textContent.includes(${JSON.stringify(label)}))`)
  await wait(`!document.querySelector('[role="listbox"]')`, 'model menu closed')
}
async function checkFreeChat() {
  await selectChatModel('QA Free Native')
  const requestsBefore = requests.length
  const startsBefore = starts().length
  await fill('CHAT', 'FREE_CHAT_FIRST_QA')
  await click(sendButton('CHAT'))
  await finish('CHAT', 'QA_PLAIN_CHAT_REPLY FREE_CHAT_FIRST_QA')
  const first = starts().at(-1).args[0]
  assert.equal(first.model, 'opencode-free/qa-free')
  assert.equal(first.workspaceId, '')
  assert.equal(first.sessionId, '')
  assert.equal(first.systemPrompt, prompt.prompt)
  assert.equal(starts().length, startsBefore + 1)
  assert.equal(requests.length, requestsBefore, 'Free chat never verifies or sends through the proxy')
  const sessionId = agent.sessionId
  await delay(650)
  await window.reload()
  await wait(ready('CHAT'), 'free chat restored')
  await fill('CHAT', 'FREE_CHAT_FOLLOWUP_QA')
  await click(sendButton('CHAT'))
  await finish('CHAT', 'QA_PLAIN_CHAT_REPLY FREE_CHAT_FOLLOWUP_QA')
  assert.equal(starts().at(-1).args[0].sessionId, sessionId)
  assert.ok(starts().at(-1).args[0].history.some(message => message.content === 'FREE_CHAT_FIRST_QA'))
  results.push('CHAT: free models use native IPC without proxy verification, preserve the task prompt and resume after reload')

  await fill('CHAT', 'FREE_CHAT_LIMIT_QA')
  await click(sendButton('CHAT'))
  await finish('CHAT', "OpenCode's free service reached a rate or quota limit")
  assert.ok(await js(`document.body.textContent.includes('QA_FREE_RATE_LIMIT')`), 'The original error remains available in Details')
  const limitedStarts = starts().length
  await delay(800)
  assert.equal(starts().length, limitedStarts, 'Rate limits must not trigger automatic retries or account switching')
  assert.equal(requests.length, requestsBefore)
  await fill('CHAT', 'FREE_CHAT_WAIT_QA')
  await click(sendButton('CHAT'))
  await wait(`!!(${stopButton('CHAT')}) && document.body.innerText.includes('QA_PLAIN_CHAT_REPLY FREE_CHAT_WAIT_QA')`, 'free chat running')
  await click(stopButton('CHAT'))
  await wait(`!(${stopButton('CHAT')})`, 'free chat stopped')
  assert.equal(agent.running, false)
  results.push('CHAT: free rate limits surface without resubmission; Stop cancels the owned native request')

  freeCatalogueStale = true
  await click(`document.querySelector('button[title="Refresh models"]')`)
  await wait(`!document.querySelector('button[title="Refresh models"]').disabled && document.body.textContent.includes('The OpenCode free model catalogue could not be verified')`, 'stale free catalogue')
  await fill('CHAT', 'FREE_CHAT_FIRST_QA')
  assert.equal(await js(`(${sendButton('CHAT')}).disabled`), true, 'Stale free models cannot be sent')
  assert.equal(calls.filter(call => call.operation === 'companion:openCodeModels').at(-1).args[0], true)
  await selectChatModel('qa-model ·')
  await fill('CHAT', 'Normal model remains available')
  await click(sendButton('CHAT'))
  await finish('CHAT', 'QA_PLAIN_CHAT_REPLY')
  assert.equal(proxyRequests().at(-1).body.model, 'qa-model')

  freeCatalogueStale = false
  proxyCatalogueUnavailable = true
  await click(`document.querySelector('button[title="Refresh models"]')`)
  await wait(`!document.querySelector('button[title="Refresh models"]').disabled && document.body.textContent.includes('HTTP 503')`, 'proxy catalogue unavailable')
  await selectChatModel('QA Free Native')
  await fill('CHAT', 'FREE_CHAT_FIRST_QA')
  await click(sendButton('CHAT'))
  await finish('CHAT', 'QA_PLAIN_CHAT_REPLY FREE_CHAT_FIRST_QA')
  assert.equal(starts().at(-1).args[0].model, 'opencode-free/qa-free')
  results.push('CHAT: refresh revalidates the catalogue; stale free models are blocked and either catalogue can fail independently')
  proxyCatalogueUnavailable = false
  await screenshot('chat-opencode-free')
}
async function historyRecord(surface) {
  if (surface === 'CHAT') return js(`JSON.parse(localStorage.getItem('dailyworkmate.chat.workspace.v1'))`)
  return js(`new Promise((resolve,reject) => {const request=indexedDB.open('dailyworkmate.companion.history.v1');request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result;const get=db.transaction('conversations').objectStore('conversations').getAll();get.onsuccess=()=>{resolve(get.result.sort((a,b)=>b.savedAt-a.savedAt)[0]);db.close()};get.onerror=()=>reject(get.error)}})`)
}

async function checkKilo(surface) {
  await click(`document.querySelector('button[title="Refresh models"]')`)
  await wait(`!document.querySelector('button[title="Refresh models"]').disabled`, surface + ' Kilo catalogue loaded')
  await selectWorkspace('none')
  if (surface === 'CHAT') await selectChatModel('QA Kilo Free')
  else await js(`(() => { const element = document.querySelector('.companion-model-select'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(element,${JSON.stringify(kiloId)}); element.dispatchEvent(new Event('change',{bubbles:true})); })()`)
  await wait(`document.body.innerText.includes('may log prompts')`, surface + ' Kilo privacy notice')
  if (surface === 'COMPANION') assert.ok(await js(`!![...document.querySelectorAll('.companion-model-select optgroup')].find(group => group.label === 'Kilo free models' && group.querySelector('option').textContent === 'QA Kilo Free')`))
  const before = starts().length, plain = proxyRequests().length
  await fill(surface, 'KILO_SELECTION_' + surface)
  await click(sendButton(surface))
  await finish(surface, 'QA_PLAIN_CHAT_REPLY')
  if (surface === 'CHAT') { assert.equal(starts().length, before); assert.equal(proxyRequests().length, plain + 1); assert.equal(proxyRequests().at(-1).body.model, kiloId) }
  else { assert.equal(starts().at(-1).args[0].model, kiloId); assert.equal(starts().at(-1).args[0].workspaceId, '') }
  for (const width of [1360, 540]) {
    window.setSize(width, 920)
    for (const theme of ['light', 'dark']) {
      await js(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); document.documentElement.classList.toggle('dark', ${JSON.stringify(theme)} === 'dark')`)
      await screenshot(surface.toLowerCase() + '-kilo-' + width + '-' + theme)
      assert.ok(await js('document.documentElement.scrollWidth <= innerWidth + 2'), surface + ' horizontal overflow')
      if (surface === 'CHAT' && width === 540) assert.ok(await js(`document.querySelector('[role="combobox"][aria-label="Select a model"]').getBoundingClientRect().width > 120`), 'Narrow model selector must remain readable')
    }
  }
  window.setSize(1360, 920)
  await js("document.documentElement.setAttribute('data-theme', 'light'); document.documentElement.classList.remove('dark')")
  kiloCatalogueStale = true
  const refresh = `document.querySelector('button[title="Refresh models"]')`
  await click(refresh)
  await wait(`document.body.textContent.includes('QA_KILO_CATALOGUE_UNAVAILABLE')`, surface + ' Kilo refresh outage')
  if (surface === 'CHAT') await selectChatModel('qa-model · QA node')
  else assert.ok(await js("[...document.querySelector('.companion-model-select').options].some(option => option.value === 'qa-model')"))
  kiloCatalogueStale = false
  await click(refresh)
  await wait(`!document.body.textContent.includes('QA_KILO_CATALOGUE_UNAVAILABLE')`, surface + ' Kilo refresh recovery')
  results.push(surface + ': Kilo source group, privacy, explicit selection, isolated catalogue outage/recovery and responsive themes')
}

async function checkSurface(surface) {
  // Each page starts with a read-only grant and its own independent history.
  snapshot = { ...snapshot, workspaces: snapshot.workspaces.map(item => ({ ...item, writable: false })) }
  const initialWorkspaces = snapshot.workspaces
  assert.ok(initialWorkspaces.some(item => item.id === 'qa-folder'))
  await loadSurface(surface)
  if (surface === 'CHAT') {
    await click(`[...document.querySelectorAll('button')].find(element => element.textContent.includes('QA workspace task') && element.getClientRects().length)`)
    await wait(`JSON.parse(localStorage.getItem('dailyworkmate.chat.workspace.v1')).promptId === 'qa-prompt'`, 'Chat system task selected')
  }
  await selectWorkspace('folder:qa-folder')
  const plainBefore = proxyRequests().length
  const first = await send(surface, 'READ')
  assert.ok(!first.sessionId, 'A new workspace conversation starts a fresh native session')
  assert.equal(first.systemPrompt, surface === 'CHAT' ? prompt.prompt : snapshot.settings.persona, 'The selected task or persona must reach the workspace runtime')
  await finish(surface, 'QA_READ_' + surface + '_COMPLETE: WORKSPACE_CHAT_READ_CONTENT')
  assert.ok(calls.some(call => call.operation === 'companion:pollAgent'), 'Renderer must poll running workspace work')
  await wait(`[...document.querySelectorAll('[data-agent-activity] li')].some(element => element.textContent.includes('read') && element.textContent.includes('completed') && element.textContent.includes('hello.txt'))`, surface + ' tool trace retained')
  await delay(650)
  let persisted = await historyRecord(surface)
  assert.ok(persisted.messages.some(message => message.tools?.some(tool => tool.name === 'read' && tool.status === 'completed')), 'The completed read trace must be saved')
  results.push(surface + ': send invokes file-capable agent, polls, reads isolated file and saves its actual tool trace')

  await send(surface, 'WRITE')
  await finish(surface, 'QA_WRITE_' + surface + '_DENIED')
  assert.ok(!fs.existsSync(path.join(workspace, 'written-' + surface.toLowerCase() + '.txt')), 'Read-only request must not create a file')
  assert.ok(await js(`[...document.querySelectorAll('[role="alert"]')].some(element => element.textContent.includes('QA_READ_ONLY_DENIED'))`), 'Read-only error remains available in its UI details')
  const readOnlyCommands = commandExecutions.length
  await send(surface, 'COMMAND')
  await finish(surface, 'QA_COMMAND_' + surface + '_DENIED')
  assert.equal(commandExecutions.length, readOnlyCommands, 'Read-only grants must not execute a command')
  assert.ok(await js(`[...document.querySelectorAll('[role="alert"]')].some(element => element.textContent.includes('QA_COMMAND_ACCESS_DENIED'))`), 'Read-only command denial must be visible')
  assert.ok(!await js(`!!(${button('Allow once')}) || !!(${button('Reject')})`), 'A denied command must not ask for approval')
  await setWritable(surface, true)
  const write = await send(surface, 'WRITE')
  assert.ok(!write.sessionId, 'Changing a grant must invalidate the previous native session')
  await finish(surface, 'QA_WRITE_' + surface + '_COMPLETE')
  assert.equal(fs.readFileSync(path.join(workspace, 'written-' + surface.toLowerCase() + '.txt'), 'utf8'), 'QA_WRITE_' + surface + '_CONTENT')
  assert.ok(write.history?.some(message => message.content.includes('WORKSPACE_CHAT_READ_CONTENT')), 'Starting a new permission-bound session retains conversation context')
  results.push(surface + ': read-only denial is visible; editable grant starts a fresh session and writes only the QA directory')

  const commandCount = commandExecutions.length
  const permissionReplies = calls.filter(call => call.operation === 'companion:replyPermission').length
  for (let index = 0; index < 2; index++) {
    await send(surface, 'COMMAND')
    assert.deepEqual(agent.permissions, [], 'Authorized chat commands must start without an approval request')
    assert.ok(!await js(`!!(${button('Allow once')}) || !!(${button('Reject')})`), 'Authorized commands must not display an approval dialog')
    await finish(surface, 'QA_COMMAND_' + surface + '_COMPLETE')
    assert.equal(commandExecutions.length, commandCount + index + 1, 'Every authorized command must execute without a permission reply')
  }
  assert.equal(calls.filter(call => call.operation === 'companion:replyPermission').length, permissionReplies)
  await wait(`[...document.querySelectorAll('[data-agent-activity] li')].some(element => element.textContent.includes('shell') && element.textContent.includes('completed'))`, surface + ' command tool trace')
  results.push(surface + ': writable authorized commands execute twice without approval UI or permission IPC; read-only commands remain denied')

  await send(surface, 'WAIT')
  await wait(`!!(${stopButton(surface)}) && document.body.innerText.includes('QA_' + ${JSON.stringify(surface)} + '_PARTIAL')`, surface + ' running stop control')
  const stops = calls.filter(call => call.operation === 'companion:stopAgent').length
  await click(stopButton(surface))
  await wait(`!(${stopButton(surface)})`, surface + ' stopped')
  assert.ok(calls.filter(call => call.operation === 'companion:stopAgent').length > stops, 'Stop must cancel the native task')
  assert.equal(agent.running, false)
  await delay(650)
  await window.reload()
  await wait(ready(surface), surface + ' history reload')
  assert.ok(await js(`document.body.innerText.includes('QA_WRITE_' + ${JSON.stringify(surface)} + '_COMPLETE') && document.body.innerText.includes('QA_' + ${JSON.stringify(surface)} + '_PARTIAL')`), 'Reload retains completed answers and stopped partial output')
  assert.ok(!await js(`!!(${button('Allow once')}) || !!(${stopButton(surface)})`), 'History reload must not restore a running task or stale permission')
  persisted = await historyRecord(surface)
  assert.ok(persisted.agentSessionId, 'Native conversation ID must be retained for continuation')
  assert.equal(persisted.agentWorkspaceId, 'qa-folder')
  const resumed = await send(surface, 'READ')
  assert.equal(resumed.sessionId, persisted.agentSessionId, 'Sending from restored history resumes the native conversation')
  await finish(surface, 'QA_READ_' + surface + '_COMPLETE: WORKSPACE_CHAT_READ_CONTENT')
  assert.equal(proxyRequests().length, plainBefore)
  results.push(surface + ': Stop cancels IPC; reload keeps partial text/tool history and resumes the same permission-bound native conversation')
  await selectWorkspace('group:qa-group')
  const grouped = await send(surface, 'READ')
  assert.equal(grouped.groupId, 'qa-group')
  assert.equal(grouped.accessScope, 'group')
  assert.ok(!grouped.sessionId, 'Selecting a workspace group starts a separate permission-bound native session')
  await finish(surface, 'QA_READ_' + surface + '_COMPLETE: WORKSPACE_CHAT_READ_CONTENT')
  results.push(surface + ': whole-group selection reaches startAgent and isolates its native session')
  await screenshot(surface.toLowerCase() + '-workspace-chat')

  await selectWorkspace('folder:qa-folder')
  await click(button('Manage access'))
  await click(`document.querySelector('[role="dialog"] button[aria-label="Remove access QA workspace"]')`)
  await wait(`!document.querySelector('[role="dialog"] select[aria-label="QA workspace access"]')`, surface + ' grant revoked')
  await click(button('Close'))
  await wait(`!document.querySelector('[role="dialog"]')`, surface + ' revoked grant dialog closed')
  const revokedStarts = starts().length, revokedCommands = commandExecutions.length
  await fill(surface, 'UI_COMMAND_' + surface + '_QA: Try the previously authorized folder.')
  await click(sendButton(surface))
  await wait(`[...document.querySelectorAll('[role="alert"]')].some(element => element.textContent.includes('Workspace access was removed')) && !(${stopButton(surface)})`, surface + ' revoked grant error')
  assert.equal(starts().length, revokedStarts, 'A revoked workspace must be rejected before starting the agent')
  assert.equal(commandExecutions.length, revokedCommands, 'A revoked grant must not execute a command')
  assert.ok(!await js(`!!(${button('Allow once')}) || !!(${button('Reject')})`), 'Revoked access must not offer a command approval')
  results.push(surface + ': revoking a selected grant blocks command execution before agent IPC')

  await selectWorkspace('none')
  const plainStarts = starts().length, plainRequests = proxyRequests().length
  await fill(surface, 'PLAIN_' + surface + '_QA: regular chat without filesystem tools')
  await click(sendButton(surface))
  await finish(surface, 'QA_PLAIN_CHAT_REPLY')
  if (surface === 'COMPANION') {
    assert.equal(starts().length, plainStarts + 1, 'Ordinary Companion chat uses OpenCodeV2')
    const plainInput = starts().at(-1).args[0]
    assert.equal(plainInput.prompt, 'PLAIN_COMPANION_QA: regular chat without filesystem tools')
    assert.equal(plainInput.workspaceId, '')
    assert.ok(!plainInput.sessionId, 'Removing the workspace must not reuse its filesystem-enabled native session')
    assert.equal(proxyRequests().length, plainRequests, 'Ordinary Companion chat cannot bypass the agent through HTTP')
    results.push(surface + ': no-workspace chat uses a fresh OpenCodeV2 session with no inherited folder grant')
  } else {
    assert.equal(starts().length, plainStarts)
    assert.equal(proxyRequests().length, plainRequests + 1)
    assert.equal(proxyRequests().at(-1).body.messages.at(-1).content, 'PLAIN_CHAT_QA: regular chat without filesystem tools')
    results.push(surface + ': no-workspace selection retains the normal OpenAI chat route')
    await checkFreeChat()
  }
  snapshot = { ...snapshot, workspaces: initialWorkspaces }
}

async function nativeClick(code) {
  await wait(`!!(${code}) && !(${code}).disabled`, 'native clickable ' + code.slice(0, 80))
  const point = await js(`(() => { const element = (${code}); element.scrollIntoView({block:'nearest'}); const rect = element.getBoundingClientRect(); return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }; })()`)
  window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
  window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
  await delay(100)
}
async function keyboardText(selector, text) {
  await nativeClick(`document.querySelector(${JSON.stringify(selector)})`)
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] })
  for (const character of text) window.webContents.sendInputEvent({ type: 'char', keyCode: character })
  await wait(`document.querySelector(${JSON.stringify(selector)}).value === ${JSON.stringify(text)}`, 'keyboard text ' + text)
  assert.equal(await js(`document.activeElement === document.querySelector(${JSON.stringify(selector)})`), true)
}
const noModal = `!document.querySelector('[role="dialog"][data-state="open"]') && getComputedStyle(document.body).pointerEvents !== 'none'`
const topDialogButton = text => `[...document.querySelectorAll('[role="dialog"][data-state="open"]')].at(-1) && [...[...document.querySelectorAll('[role="dialog"][data-state="open"]')].at(-1).querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(text)})`
async function navigate(surface) {
  await js(`location.hash = ${JSON.stringify(surface === 'CHAT' ? '/chat' : '/')}`)
  await wait(`${ready(surface)} && ${noModal}`, 'navigation released dialogs: ' + surface)
}
async function checkInputRecovery() {
  // Keep Assistant mounted while changing routes, exactly as the app does.
  await loadSurface('COMPANION')
  await keyboardText('.companion-composer textarea', 'before workspace dialogs')
  for (const outcome of ['cancel', 'add', 'error']) {
    workspacePickerOutcome = outcome
    await nativeClick(`document.querySelector('.companion-folder-button')`)
    const before = calls.filter(call => call.operation === 'companion:addWorkspace').length
    await nativeClick(button('Add folder'))
    await wait(`!(${button('Add folder')}).disabled`, 'folder picker releases busy state: ' + outcome)
    assert.equal(calls.filter(call => call.operation === 'companion:addWorkspace').length, before + 1)
    await keyboardText('input[aria-label="Search authorized folders"]', 'QA')
    await nativeClick(topDialogButton('Close'))
    await wait(noModal, 'folder dialog closed: ' + outcome)
    await keyboardText('.companion-composer textarea', 'after folder ' + outcome)
  }
  results.push('Assistant: folder selection, cancellation and failure release Add folder and accept keyboard input again')

  await nativeClick(`document.querySelector('.companion-folder-button')`)
  const original = snapshot.workspaces.find(folder => folder.id === 'qa-folder').writable
  const access = `document.querySelector('[data-authorized-folder="qa-folder"] select')`
  const changeAccess = () => js(`(() => { const element = ${access}; element.value = ${JSON.stringify(original ? 'read' : 'write')}; element.dispatchEvent(new Event('change', {bubbles:true})); })()`)
  await changeAccess()
  await wait(`document.querySelectorAll('[role="dialog"]').length === 2`, 'nested access confirmation')
  await nativeClick(topDialogButton('Cancel'))
  await wait(`document.querySelectorAll('[role="dialog"]').length === 1`, 'nested confirmation cancelled')
  assert.equal(snapshot.workspaces.find(folder => folder.id === 'qa-folder').writable, original)
  await keyboardText('input[aria-label="Search authorized folders"]', 'QA workspace')
  await changeAccess()
  await wait(`document.querySelectorAll('[role="dialog"]').length === 2`, 'nested access confirmation again')
  await nativeClick(topDialogButton('Confirm'))
  await wait(`document.querySelectorAll('[role="dialog"]').length === 1 && !(${button('Add folder')}).disabled`, 'nested confirmation applied')
  assert.equal(snapshot.workspaces.find(folder => folder.id === 'qa-folder').writable, !original)
  // Hiding a kept-alive page must also remove its portalled folder dialog.
  await navigate('CHAT')
  await keyboardText('[data-chat-ready] textarea', 'draft before leaving confirmation')
  const chatId = await js(`JSON.parse(localStorage.getItem('dailyworkmate.chat.workspace.v1')).conversationId`)
  await nativeClick(button('Clear chat'))
  await wait(`!!document.querySelector('[role="dialog"][data-state="open"]')`, 'clear pending before route change')
  await navigate('COMPANION')
  await keyboardText('.companion-composer textarea', 'assistant after cancelled clear')
  await navigate('CHAT')
  assert.equal(await js(`JSON.parse(localStorage.getItem('dailyworkmate.chat.workspace.v1')).conversationId`), chatId, 'Leaving a pending confirmation must not delete its conversation')
  assert.equal(await js(`document.querySelector('[data-chat-ready] textarea').value`), 'draft before leaving confirmation')
  await nativeClick(button('Clear chat'))
  await wait(`!!document.querySelector('[role="dialog"][data-state="open"]')`, 'clear after returning')
  await nativeClick(topDialogButton('Confirm'))
  await wait(`${ready('CHAT')} && ${noModal}`, 'clear complete')
  await keyboardText('[data-chat-ready] textarea', 'chat after clear')
  await expandWorkspace()
  await nativeClick(button('Manage access'))
  workspacePickerOutcome = 'cancel'
  await nativeClick(button('Add folder'))
  await wait(`!(${button('Add folder')}).disabled`, 'Chat folder picker cancelled')
  await nativeClick(topDialogButton('Close'))
  await wait(noModal, 'Chat workspace dialog released input')
  await keyboardText('[data-chat-ready] textarea', 'chat after workspace picker')
  await navigate('COMPANION')
  await keyboardText('.companion-composer textarea', 'assistant after chat clear')
  results.push('Nested permission dialogs, pending-confirmation navigation, Chat clear and retained Assistant pages release all modal locks and accept real keyboard input')
}

async function run() {
  await app.whenReady()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  config = { proxyHost: '127.0.0.1', proxyPort: server.address().port, requestTimeout: 5000, retryCount: 0, apiKeys: [], enableApiKey: false, modelMappings: {}, loadBalanceStrategy: 'round-robin', theme: 'light', language: 'en-US', modelFeatureDefaults: { vision: 'auto', thinking: 'auto' } }
  snapshot = {
    settings: { name: 'QA companion', persona: 'QA_COMPANION_PERSONA: use the authorized workspace to complete file requests.', model: 'qa-model', autoSpeak: false, speechEnabled: false, ttsMode: 'local', sttMode: 'local', localVoice: 'auto', localEngine: 'fast', systemFallback: false, language: 'zh-CN', systemVoice: '', voice: 'alloy', speechRate: 1, speechVolume: 1, speechPitch: 1, readingMode: 'full', avatar: '', avatarVisible: false, avatarMode: '2d', avatarModel: '', stt: { baseUrl: '', model: 'whisper-1', apiKey: '' }, tts: { baseUrl: '', model: 'tts-1', apiKey: '' } },
    workspaces: [{ id: 'qa-folder', path: workspace, name: 'QA workspace', writable: false }, { id: 'qa-other', path: otherWorkspace, name: 'QA other folder', writable: false }],
    groups: [{ id: 'qa-group', name: 'QA folder group', workspaceIds: ['qa-folder', 'qa-other'] }], messages: [], home: scratch, avatarUrl: '', avatarModelUrl: '', runtimeAvailable: true,
  }
  window = new BrowserWindow({ show: false, width: 1360, height: 920, webPreferences: { offscreen: true, preload: path.join(root, 'tests/renderer/fixtures/workspace-chat-preload.cjs'), contextIsolation: true, sandbox: false, nodeIntegration: false, backgroundThrottling: false } })
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3 && !message.includes('Content Security Policy')) errors.push(message) })
  if (!process.argv.includes('--focus-only')) {
    await checkSurface('CHAT')
    await checkKilo('CHAT')
    await checkSurface('COMPANION')
    await checkKilo('COMPANION')
  }
  await checkInputRecovery()
  assert.deepEqual(errors, [])
  fs.writeFileSync(path.join(scratch, 'report.json'), JSON.stringify({ passed: true, results, calls, requests, commandExecutions }, null, 2))
  console.log('PASS: ' + results.join('\nPASS: '))
  console.log('QA output: ' + scratch)
}
run().catch(async error => {
  console.error(error)
  process.exitCode = 1
  fs.writeFileSync(path.join(scratch, 'failure.json'), JSON.stringify({ error: error.message, results, calls, requests, errors,
    inputState: window && !window.isDestroyed() ? await js(`({ pointerEvents: document.body.style.pointerEvents, chatReady: document.querySelector('[data-chat-ready]')?.dataset.chatReady, dialogs: [...document.querySelectorAll('[role="dialog"]')].map(el => ({state:el.dataset.state,text:el.textContent.slice(0,300)})), focus: document.activeElement?.outerHTML.slice(0,400) })`).catch(() => null) : null,
    text: window && !window.isDestroyed() ? await js('document.body.innerText').catch(() => '') : '' }, null, 2))
  if (window && !window.isDestroyed()) await screenshot('failure').catch(() => {})
  console.error('QA output: ' + scratch)
}).finally(() => { shuttingDown = true; window?.destroy(); server.closeAllConnections(); server.close(); app.exit(process.exitCode || 0) })
