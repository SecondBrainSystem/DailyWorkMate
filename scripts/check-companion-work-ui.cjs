// Hidden Electron UI + real native OpenCode TUI. All profiles and model responses are isolated.
const { app, BrowserWindow, ipcMain } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..')
const scratch = fs.mkdtempSync(path.join(root, 'tmp', 'companion-work-ui-'))
const workspace = path.join(scratch, 'workspace')
fs.mkdirSync(path.join(workspace, 'docs'), { recursive: true })
fs.writeFileSync(path.join(workspace, 'hello.txt'), 'NATIVE_UI_FILE_CONTENT')
app.setPath('userData', path.join(scratch, 'profile'))
app.disableHardwareAcceleration()
buildSync({ stdin: { contents: "export { OpenCodeService } from './src/main/companion/opencode.ts'; export { OpenCodeTerminalService } from './src/main/companion/terminal.ts';", resolveDir: root }, outfile: path.join(scratch, 'service.cjs'), bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
const { OpenCodeService, OpenCodeTerminalService } = require(path.join(scratch, 'service.cjs'))
let window, terminal, agent, terminalOutput = '', closing = false
const calls = [], requests = [], errors = [], consoleMessages = []
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const server = http.createServer(async (req, res) => {
  try {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-DailyWorkMate-Model-Selection')
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return }
    if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: 'qa-model' }, { id: 'qa-model-alt' }] })); return }
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    if (req.url === '/v1/models/verify') { res.end(JSON.stringify({ model: body.model, verified: true })); return }
    requests.push(body)
    const tool = body.messages.some(message => message.role === 'tool')
    const native = body.tools?.length
    const delta = native && !tool ? { tool_calls: [{ index: 0, id: 'ui_read_qa', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: path.join(workspace, 'hello.txt') }) } }] }
      : { content: native ? 'NATIVE_UI_COMPLETE: NATIVE_UI_FILE_CONTENT' : 'CHAT_UI_COMPLETE' }
    if (JSON.stringify(body.messages).includes('WAIT_MUTED_QA')) await sleep(900)
    res.setHeader('Content-Type', 'text/event-stream')
    res.write('data: ' + JSON.stringify({ id: 'qa', object: 'chat.completion.chunk', model: body.model, created: 1, choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n')
    res.write('data: ' + JSON.stringify({ id: 'qa', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: native && !tool ? 'tool_calls' : 'stop' }] }) + '\n\n')
    res.end('data: [DONE]\n\n')
  } catch (error) { errors.push(error.message); res.writeHead(500).end(error.message) }
})
const js = code => window.webContents.executeJavaScript(code, true)
const button = text => `[...document.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(text)})`
async function wait(code, label, timeout = 40000) {
  const end = Date.now() + timeout
  while (!(await js(code))) { if (Date.now() > end) throw new Error('Timed out: ' + label); await sleep(100) }
}
async function click(code) { await wait(`!!(${code}) && !(${code}).disabled`, 'clickable control'); await js(`(${code}).click()`); await sleep(120) }
async function fill(value) {
  await js(`(() => { const el = document.querySelector('.companion-composer textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true})); })()`)
  await sleep(120)
}
async function select(selector, value) {
  await js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,${JSON.stringify(value)}); el.dispatchEvent(new Event('change',{bubbles:true})); })()`)
  await sleep(120)
}
async function screenshot(name) {
  await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  await sleep(250)
  fs.writeFileSync(path.join(scratch, name + '.png'), (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG())
}
const ready = `!!document.querySelector('[data-companion-ready="true"]')`
const speechSwitch = `document.querySelector('[role="switch"][aria-label="Read replies aloud"]')`
const openFolders = `document.querySelector('[aria-label="Folder access"]')`
const visibleState = `document.querySelector('.companion-terminal:not([hidden]) .companion-terminal-state')?.textContent`
const chatIdle = `document.querySelector('.companion-messages')?.getAttribute('aria-busy') === 'false'`
async function installSpeechMock() {
  await js(`window.qaSpeech={started:0,cancelled:0};window.SpeechSynthesisUtterance=class{constructor(text){this.text=text}};Object.defineProperty(window,'speechSynthesis',{configurable:true,value:{getVoices:()=>[{lang:'zh-CN',voiceURI:'qa-voice'}],cancel:()=>{window.qaSpeech.cancelled++},speak:utterance=>{window.qaSpeech.started++;utterance.onstart?.();setTimeout(()=>utterance.onend?.(),10000)}}});void 0;`)
}
app.whenReady().then(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  window = new BrowserWindow({ show: false, width: 1360, height: 900, webPreferences: { offscreen: true, preload: path.join(root, 'tests/renderer/fixtures/companion-preload.cjs'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    additionalArguments: ['--companion-native-terminal', '--companion-qa-port=' + server.address().port, '--companion-qa-workspace=' + workspace] } })
  window.webContents.on('console-message', (_event, level, message) => { if (level === 3) consoleMessages.push(message) })
  const storage = { home: scratch, get: () => js('window.electronAPI.companion.get()') }
  agent = new OpenCodeService(storage, () => ({ proxyHost: '127.0.0.1', proxyPort: server.address().port, enableApiKey: false, apiKeys: [] }), path.join(root, 'companion/runtime/opencode-v2/node_modules/@opencode/cli/bin/opencode.exe'))
  terminal = new OpenCodeTerminalService(agent, scratch)
  const operations = { openTerminal: input => terminal.open(input), pollTerminal: (id, cursor) => { const state = terminal.poll(id, cursor); terminalOutput += state.data; return state }, writeTerminal: (id, data) => terminal.write(id, data), resizeTerminal: (id, cols, rows) => terminal.resize(id, cols, rows), closeTerminal: id => terminal.close(id), refreshAccess: () => terminal.refreshAccess() }
  for (const [name, operation] of Object.entries(operations)) ipcMain.handle('qa:' + name, (event, ...args) => {
    // Work tabs keep polling until the window goes away; ignore them during teardown.
    if (closing) return undefined
    assert.equal(event.sender, window.webContents)
    if (name !== 'pollTerminal') calls.push({ operation: name, input: args })
    return operation(...args)
  })
  await window.loadFile(path.join(root, 'out/renderer/index.html'))
  await wait(ready, 'default companion home')
  await installSpeechMock()
  // Disable speech while a response is pending; the completion's old closure must remain silent.
  await js(`[...document.querySelectorAll('label')].find(el=>el.textContent.trim()==='Read replies aloud').querySelector('input').click()`)
  await fill('WAIT_MUTED_QA'); await click(button('Send'))
  await click(speechSwitch)
  await wait(`${chatIdle} && document.body.textContent.includes('CHAT_QA_COMPLETE')`, 'muted completion')
  assert.equal(await js('window.qaSpeech.started'), 0)
  assert.equal(await js(`${speechSwitch}.getAttribute('aria-checked')`), 'false')
  assert.ok(await js(`document.querySelector('[aria-label^="Read in full"]').disabled`))
  await sleep(450); await window.reload(); await wait(ready, 'mute survives restart'); await installSpeechMock()
  assert.equal(await js(`${speechSwitch}.getAttribute('aria-checked')`), 'false')
  await fill('MUTED_RELOAD_QA'); await click(button('Send')); await wait(chatIdle, 'muted reply after restart')
  assert.equal(await js('window.qaSpeech.started'), 0)
  await click(speechSwitch)
  await fill('SPEAK_AND_CANCEL_QA'); await click(button('Send'))
  await wait('window.qaSpeech.started > 0', 'playback begins')
  const cancelled = await js('window.qaSpeech.cancelled')
  await click(speechSwitch)
  await wait(`window.qaSpeech.cancelled > ${cancelled} && ${chatIdle}`, 'speech switch cancels current playback')
  await screenshot('chat-muted-desktop')
  console.log('PASS: persistent speech switch, silent pending completion/restart, disabled manual reading and immediate playback cancellation')

  // Work starts empty: "New session" asks for a folder, and each tab shows the folder it works in.
  fs.mkdirSync(workspace + '-1'); fs.writeFileSync(path.join(workspace + '-1', 'other.txt'), 'OTHER')
  await click(openFolders); await click(button('Add folder')); await wait(`document.body.textContent.includes(${JSON.stringify(workspace)})`, 'folder granted')
  await click(button('Add folder')); await wait(`document.body.textContent.includes(${JSON.stringify(workspace + '-1')})`, 'second folder granted')
  await click(button('Close')); await wait(`!document.querySelector('[role="dialog"]')`, 'folder dialog closed')
  await click(button('Work'))
  await wait(`document.body.textContent.includes('Start a work session')`, 'empty Work view')
  assert.equal(calls.filter(call => call.operation === 'openTerminal').length, 0, 'nothing connects before a session is opened')
  assert.equal(await js(`!!document.querySelector('.companion-composer')`), false)
  await screenshot('work-empty')
  await click(button('New session'))
  await wait(`!!document.querySelector('[role="dialog"] select[aria-label="Work folder"]')`, 'new session dialog')
  assert.equal(await js(`document.querySelector('select[aria-label="Work folder"]').value`), 'folder:qa-folder')
  assert.ok(await js(`document.querySelector('.work-scope-summary').textContent.includes('Read only')`))
  await screenshot('work-new-session')
  await click(button('Open session'))
  await wait(`${visibleState} === 'Connected'`, 'native terminal connects')
  assert.ok(await js(`/Project.*Read only/.test(document.querySelector('.work-session-tab.is-active').textContent)`), 'the tab names its folder and permission')
  assert.deepEqual((({ workspaceId, accessScope, newSession }) => [workspaceId, accessScope, newSession])(calls.filter(call => call.operation === 'openTerminal').at(-1).input[0]), ['qa-folder', 'group', true])
  assert.equal(await js(`!!document.querySelector('.companion-stage')`), false)
  await wait(`document.querySelector('.xterm-screen')?.innerText.includes('qa-model') || !!document.querySelector('.xterm-helper-textarea')`, 'xterm rendered')
  // Type only after the TUI has drawn its status line (it names the model); keystrokes sent earlier are lost.
  const tuiDeadline = Date.now() + 45000
  while (!terminalOutput.includes('qa-model')) { if (Date.now() > tuiDeadline) throw new Error('Timed out: native TUI ready'); await sleep(100) }
  await sleep(800)
  window.webContents.focus()
  await js(`document.querySelector('.xterm-helper-textarea').focus()`)
  await js(`(() => {const el=document.querySelector('.xterm-helper-textarea');el.value='请读取 hello.txt NATIVE_UI_INPUT_QA';el.dispatchEvent(new InputEvent('input',{bubbles:true,data:el.value,inputType:'insertText'}))})()`)
  await sleep(400)
  assert.ok(calls.some(call => call.operation === 'writeTerminal' && call.input[1].includes('NATIVE_UI_INPUT_QA')), 'renderer keyboard input reaches the PTY')
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
  const replyDeadline = Date.now() + 45000
  while (!terminalOutput.includes('NATIVE_UI_COMPLETE')) { if (Date.now() > replyDeadline) throw new Error('Timed out: native terminal reply'); await sleep(100) }
  assert.ok(requests.some(request => JSON.stringify(request.messages).includes('NATIVE_UI_INPUT_QA')))
  assert.ok(requests.some(request => request.messages.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('NATIVE_UI_FILE_CONTENT'))))
  await screenshot('work-terminal-desktop')
  const saved = () => js(`JSON.parse(localStorage.getItem('dailyworkmate.companion.workSessions.v2'))`)
  const tab = text => `[...document.querySelectorAll('.work-session-tab [role="tab"]')].find(el => el.querySelector('.work-session-name').textContent === ${JSON.stringify(text)})`
  // Another folder opens straight from Folder access, beside the first and on its own server.
  await click(openFolders)
  await click(`[...document.querySelectorAll('[data-authorized-folder="qa-folder-1"] button')].find(el => el.textContent.trim() === 'New session')`)
  await wait(`!document.querySelector('[role="dialog"]') && document.querySelectorAll('.work-session-tab').length === 2 && ${visibleState} === 'Connected'`, 'second folder session connects')
  assert.equal(calls.filter(call => call.operation === 'openTerminal').at(-1).input[0].workspaceId, 'qa-folder-1')
  // A third session is narrowed to a subfolder, which turns commands off.
  await click(button('New session')); await wait(`!!document.querySelector('select[aria-label="Work folder"]')`, 'new session dialog')
  await select('select[aria-label="Work folder"]', 'folder:qa-folder')
  await click(button('Only a subfolder…'))
  await wait(`[...document.querySelectorAll('.work-subfolder-browser button')].some(el => el.textContent.trim() === 'docs')`, 'subfolders listed')
  await click(`[...document.querySelectorAll('.work-subfolder-browser button')].find(el => el.textContent.trim() === 'docs')`)
  await click(button('Use this folder'))
  await wait(`document.querySelector('.work-scope-summary').textContent.includes('No commands')`, 'narrowed scope summary')
  await click(button('Open session'))
  await wait(`document.querySelectorAll('.work-session-tab').length === 3 && ${visibleState} === 'Connected'`, 'subfolder session connects')
  assert.deepEqual((({ accessScope, relativePath }) => [accessScope, relativePath])(calls.filter(call => call.operation === 'openTerminal').at(-1).input[0]), ['folder', 'docs'])
  // Every tab stays connected; switching between them never reconnects.
  const openCount = calls.filter(call => call.operation === 'openTerminal').length
  await click(tab('Project')); await wait(`${visibleState} === 'Connected'`, 'first session still connected')
  assert.equal(calls.filter(call => call.operation === 'openTerminal').length, openCount, 'switching tabs must not reconnect')
  assert.equal(await js(`[...document.querySelectorAll('.companion-terminal-state')].filter(el => el.textContent === 'Connected').length`), 3)
  await screenshot('work-three-sessions')
  // Making Project editable reconnects only its two sessions, which resume their conversations.
  const before = await saved()
  const [projectSession, , docsSession] = before.open
  const otherTerminal = calls.filter(call => call.operation === 'openTerminal').filter(call => call.input[0].workspaceId === 'qa-folder-1').at(-1).input[0].terminalId
  // Changing access and closing a connected tab both ask for confirmation; a native dialog would block the hidden window.
  await js('window.confirm = () => true; void 0')
  await click(openFolders)
  await select('select[aria-label="Project access"]', 'write')
  await click(button('Close'))
  const reconnectDeadline = Date.now() + 60000
  while (calls.filter(call => call.operation === 'openTerminal').length < openCount + 2) { if (Date.now() > reconnectDeadline) throw new Error('Timed out: sessions reconnect after a permission change'); await sleep(100) }
  await wait(`[...document.querySelectorAll('.companion-terminal-state')].filter(el => el.textContent === 'Connected').length === 3`, 'all sessions connected again')
  const reopened = calls.filter(call => call.operation === 'openTerminal').slice(openCount).map(call => call.input[0])
  assert.deepEqual(reopened.map(item => item.workspaceId), ['qa-folder', 'qa-folder'])
  assert.deepEqual(reopened.map(item => item.sessionId).sort(), [projectSession.sessionId, docsSession.sessionId].sort(), 'affected sessions keep their own native conversation')
  assert.ok(reopened.every(item => !item.newSession))
  assert.ok(!calls.some(call => call.operation === 'closeTerminal' && call.input[0] === otherTerminal), 'the other folder kept running')
  assert.ok(await js(`/Project.*Can edit/.test(document.querySelector('.work-session-tab.is-active').textContent)`))
  // Closing a tab ends it; Recent sessions reopens the same conversation.
  await click(tab('docs')); await wait(`${visibleState} === 'Connected'`, 'docs session shown')
  const docsTerminal = calls.filter(call => call.operation === 'openTerminal').filter(call => call.input[0].relativePath === 'docs').at(-1).input[0].terminalId
  await click(`document.querySelector('.work-session-tab.is-active .work-session-close')`)
  await wait(`document.querySelectorAll('.work-session-tab').length === 2`, 'tab closed')
  assert.ok(calls.some(call => call.operation === 'closeTerminal' && call.input[0] === docsTerminal))
  await click(`[...document.querySelectorAll('button')].find(el => el.textContent.trim().startsWith('Recent sessions'))`)
  await wait(`!!document.querySelector('[role="dialog"] [data-recent-session]')`, 'recent sessions listed')
  await screenshot('work-recent')
  await click(`[...document.querySelectorAll('[role="dialog"] [data-recent-session] button')].find(el => el.textContent.trim() === 'Open')`)
  await wait(`document.querySelectorAll('.work-session-tab').length === 3 && ${visibleState} === 'Connected'`, 'session reopened')
  assert.equal(calls.filter(call => call.operation === 'openTerminal').at(-1).input[0].sessionId, docsSession.sessionId)
  // Chat and back: Work sessions stay connected.
  const opensBeforeChat = calls.filter(call => call.operation === 'openTerminal').length
  await click(button('Chat')); await wait(`${chatIdle} && !!document.querySelector('.companion-composer')`, 'chat view')
  await click(button('Work')); await wait(`${visibleState} === 'Connected'`, 'work view again')
  assert.equal(calls.filter(call => call.operation === 'openTerminal').length, opensBeforeChat, 'switching to Chat keeps Work sessions connected')
  for (const [width, theme] of [[1360, 'dark'], [540, 'light'], [540, 'dark']]) {
    window.setSize(width, 900)
    await js(`document.documentElement.setAttribute('data-theme',${JSON.stringify(theme)});document.documentElement.classList.toggle('dark',${theme === 'dark'})`)
    await sleep(350)
    assert.ok(await js('document.documentElement.scrollWidth <= window.innerWidth + 1'), 'page must fit viewport')
    await screenshot('work-terminal-' + width + '-' + theme)
  }
  window.setSize(1360, 900)
  await js(`document.documentElement.setAttribute('data-theme','light');document.documentElement.classList.remove('dark')`)
  await click(`document.querySelector('[aria-label="Switch to Chinese"]')`)
  await wait(`document.body.textContent.includes('新会话') && document.body.textContent.includes('最近会话')`, 'Chinese Work view')
  await screenshot('work-terminal-1360-zh')
  await click(`document.querySelector('[aria-label="Switch to English"]')`)
  await wait(`!!${button('Chat')}`, 'English again')
  await click(button('Chat')); await wait(`${chatIdle} && !!document.querySelector('.companion-composer')`, 'normal chat restored')
  assert.ok(await js(`document.body.textContent.includes('CHAT_QA_COMPLETE')`))
  assert.equal(agent.isBusy(), true, 'Work sessions stay connected while chatting')
  assert.equal(errors.length, 0, errors.join('\n'))
  assert.equal(consoleMessages.length, 0, consoleMessages.join('\n'))
  fs.writeFileSync(path.join(scratch, 'report.json'), JSON.stringify({ passed: true, requests: requests.length, operations: calls.filter(call => !['writeTerminal', 'resizeTerminal'].includes(call.operation)), checks: ['speech switch', 'empty Work view', 'new session dialog', 'native Electron PTY', 'Unicode keyboard input', 'guarded read', 'session from Folder access', 'subfolder session', 'three servers side by side', 'targeted permission reconnect', 'close and reopen from Recent', 'Work stays connected in Chat', 'chat restore', 'desktop/mobile', 'light/dark'] }, null, 2))
  console.log('PASS: real Electron PTY, folder-bound Work sessions side by side, permission changes reconnect only affected sessions, close/reopen from Recent, chat restore and light/dark responsive layouts')
}).catch(async error => {
  console.error(error); process.exitCode = 1
  if (window && !window.isDestroyed()) { fs.writeFileSync(path.join(scratch, 'failure.json'), JSON.stringify({ error: error.stack, text: await js('document.body.innerText'), calls, requests, errors, consoleMessages }, null, 2)); await screenshot('failure') }
}).finally(async () => {
  closing = true; window?.destroy(); await terminal?.close(); await agent?.dispose()
  server.closeAllConnections(); server.close()
  console.log('QA artifacts: ' + scratch)
  app.exit(process.exitCode || 0)
})
