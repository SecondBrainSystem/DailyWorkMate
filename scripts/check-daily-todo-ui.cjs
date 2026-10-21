// Isolated Electron acceptance: actual companion UI, authorized local files and xterm clipboard/state.
// Run after npm run build: node_modules/.bin/electron scripts/check-daily-todo-ui.cjs
const { app, BrowserWindow, ipcMain, clipboard } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..')
const packagedArgument = process.argv.find(value => value.startsWith('--packaged='))
const renderer = packagedArgument ? path.join(path.resolve(packagedArgument.slice('--packaged='.length)), 'resources/app.asar/out/renderer/index.html') : path.join(root, 'out/renderer/index.html')
const scratch = fs.mkdtempSync(path.join(root, 'tmp', 'daily-todo-ui-'))
const workspace = path.join(scratch, 'workspace')
const daily = path.join(workspace, 'Daily')
fs.mkdirSync(daily, { recursive: true })
const date = new Date()
const day = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-')
const file = path.join(daily, day + '.md')
const document = '# 今日重点\n\n- [x] 整理昨天的工作记录\n- [ ] 完成**项目方案**与时间安排\n  - [ ] 核对嵌套事项\n- [ ] 检查终端任务状态\n\n## 留给自己\n> 一次只专注一件事。\n\n| 时段 | 计划 |\n| --- | --- |\n| 上午 | 写作 |\n| 下午 | Review |\n\n```md\n- [ ] 这只是代码示例\n```\n\n[项目参考](https://example.com)\n<script>window.TODO_UNSAFE = true</script>'
fs.writeFileSync(file, document)
app.setPath('userData', path.join(scratch, 'profile'))
app.disableHardwareAcceleration()
buildSync({ entryPoints: [path.join(root, 'src/main/companion/workspaces.ts')], outfile: path.join(scratch, 'workspaces.cjs'), bundle: true, platform: 'node', packages: 'external' })
const { listWorkspaceFiles, readWorkspaceFile } = require(path.join(scratch, 'workspaces.cjs'))
buildSync({ entryPoints: [path.join(root, 'src/main/companion/dailyTodo.ts')], outfile: path.join(scratch, 'dailyTodo.cjs'), bundle: true, platform: 'node' })
const { readTodo, setTodoTask, copyTodoToday } = require(path.join(scratch, 'dailyTodo.cjs'))
let grant = { id: 'qa-folder', name: 'Project', path: workspace, writable: false }
let failRead = false
ipcMain.handle('qa:daily:listFiles', (_event, id, relativePath) => { assert.equal(id, grant.id); return listWorkspaceFiles(grant, relativePath) })
ipcMain.handle('qa:daily:readFile', (_event, id, relativePath) => { assert.equal(id, grant.id); if (failRead) throw new Error('QA_FILE_UNAVAILABLE'); return readWorkspaceFile(grant, relativePath) })
ipcMain.handle('qa:daily:readTodo', (_event, id, relativePath) => { assert.equal(id, grant.id); if (failRead) throw new Error('QA_FILE_UNAVAILABLE'); return readTodo(grant, relativePath) })
ipcMain.handle('qa:daily:setTodoTask', (_event, id, relativePath, change) => { assert.equal(id, grant.id); return setTodoTask(grant, relativePath, change) })
ipcMain.handle('qa:daily:copyTodoToday', (_event, id, relativePath) => { assert.equal(id, grant.id); return copyTodoToday(grant, relativePath) })
const response = '今天的 Daily Todo：\n- [ ] 写好项目摘要\n- [x] 确认今天的安排\n- [ ] Review the checklist'
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*')
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return }
  if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: 'qa-model' }] })); return }
  if (req.url === '/v1/models/verify') { res.end(JSON.stringify({ model: 'qa-model', verified: true })); return }
  res.setHeader('Content-Type', 'text/event-stream')
  res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: response }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n')
})
let window, terminalWindow, savedClipboard
const errors = []
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const js = code => window.webContents.executeJavaScript(code, true)
async function wait(code, label, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (!(await js(code))) { if (Date.now() > deadline) throw new Error('Timeout: ' + label); await sleep(100) }
}
async function click(selector) { await wait(`!!document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled`, selector); await js(`document.querySelector(${JSON.stringify(selector)}).click()`); await sleep(80) }
async function fill(selector, value, kind = 'textarea') {
  await js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(${kind === 'select' ? 'HTMLSelectElement' : 'HTMLTextAreaElement'}.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('${kind === 'select' ? 'change' : 'input'}', { bubbles: true })); })()`)
  await sleep(80)
}
async function screenshot(name) {
  await sleep(250)
  fs.writeFileSync(path.join(scratch, name + '.png'), (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG())
}
const ready = `!!document.querySelector('[data-companion-ready="true"]')`
const noteText = `document.querySelector('.daily-todo-body')?.textContent`
async function reload() {
  const loaded = new Promise(resolve => window.webContents.once('did-finish-load', resolve))
  window.reload(); await loaded; await wait(ready, 'reload ready')
}
async function checkTerminal() {
  buildSync({ stdin: { contents: `
    import { Terminal } from '@xterm/xterm';
    import { trackActivity } from './src/renderer/src/lib/terminalActivity';
    import { enableTerminalCopy } from './src/renderer/src/lib/terminalClipboard';
    window.terminal = new Terminal({ cols: 90, rows: 12 });
    terminal.open(document.querySelector('#host'));
    window.state = 'idle'; window.sent = [];
    window.tracker = trackActivity(terminal, { shellPrompts: true, startDelay: 60, settleDelay: 60, scanInterval: 10, onChange: value => window.state = value });
    enableTerminalCopy(terminal, document.querySelector('#host'), error => { throw error });
    terminal.onData(value => sent.push(value));
    window.write = text => new Promise(resolve => terminal.write(text, () => { tracker.output(); resolve() }));
    window.key = (shift = false) => { terminal.focus(); terminal.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: shift ? 'C' : 'c', code: 'KeyC', keyCode: 67, ctrlKey: true, shiftKey: shift, bubbles: true, cancelable: true })); };
    `, resolveDir: root }, bundle: true, platform: 'browser', outfile: path.join(scratch, 'terminal.js') })
  const css = fs.readFileSync(path.join(root, 'node_modules/@xterm/xterm/css/xterm.css'), 'utf8')
  fs.writeFileSync(path.join(scratch, 'terminal.html'), `<html><head><meta charset="utf-8"><style>${css}</style></head><body><div id="host"></div><script src="terminal.js"></script></body></html>`)
  terminalWindow = new BrowserWindow({ show: false, width: 1000, height: 400, webPreferences: { offscreen: true, backgroundThrottling: false } })
  await terminalWindow.loadFile(path.join(scratch, 'terminal.html'))
  terminalWindow.webContents.debugger.attach('1.3')
  await terminalWindow.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  const run = code => terminalWindow.webContents.executeJavaScript(code, true)
  await run(`tracker.input('codex\\r'); write('>_ OpenAI Codex\\r\\n\\r\\n› Ask Codex to do anything')`); await sleep(150)
  assert.equal(await run('state'), 'idle')
  await run(`write('\\x1b[H\\x1b[2J• Working (3s • esc to cancel)\\r\\n› ')`); await sleep(100)
  assert.equal(await run('state'), 'working')
  await run(`write('\\x1b[H\\x1b[2J任务完成 COPY_QA\\r\\n› Ask Codex to do anything\\x1b[?2004l')`); await sleep(180)
  assert.equal(await run('state'), 'done')
  await run(`terminal.select(0, 0, 30); key()`); await sleep(100)
  assert.match(clipboard.readText(), /任务完成 COPY_QA/)
  assert.equal(await run(`sent.includes('\\x03')`), false, 'copy does not interrupt')
  await run(`key(true)`); await sleep(100)
  assert.match(clipboard.readText(), /COPY_QA/)
  await run(`terminal.clearSelection(); key()`); await sleep(100)
  assert.equal(await run(`sent.includes('\\x03')`), true, 'no selection still sends Ctrl+C')
  await run(`terminal.select(0, 0, 30); document.querySelector('#host').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))`); await sleep(100)
  assert.match(clipboard.readText(), /COPY_QA/)
  // Exercise OSC parsing through xterm, including a sequence split across PTY chunks.
  await run(`tracker.prompt(); terminal.reset(); write('\\x1b]7501;state=work')`)
  await run(`write('ing:app=codex\\x1b\\\\')`); await sleep(80)
  assert.equal(await run('state'), 'working')
  await run(`write('Thinking…\\r\\n› '); tracker.directory()`); await sleep(250)
  assert.equal(await run('state'), 'working', 'a live Codex turn survives a missing footer')
  await run(`write('\\x1b]7501;state=idle:app=codex\\x1b\\\\')`); await sleep(120)
  assert.equal(await run('state'), 'done')
  const captureArgument = process.argv.find(value => value.startsWith('--codex-capture='))
  if (captureArgument) {
    const events = JSON.parse(fs.readFileSync(captureArgument.slice('--codex-capture='.length), 'utf8'))
    await run('tracker.prompt(); terminal.reset(); terminal.resize(48, 30)')
    let expected = false, samples = 0
    const replayStart = Date.now()
    for (const event of events) {
      const delay = event.at - (Date.now() - replayStart)
      if (delay > 0) await sleep(delay)
      if (!event.data) continue
      await run(`write(${JSON.stringify(event.data)})`)
      if (event.data.includes('state=working:app=codex')) expected = true
      if (event.data.includes('state=idle:app=codex')) expected = false
      if (expected) { assert.equal(await run('state'), 'working', 'native Codex capture cannot finish before its actual idle event'); samples++ }
    }
    await sleep(150); assert.equal(await run('state'), 'done')
    assert.ok(samples > 20)
    fs.writeFileSync(path.join(scratch, 'codex-native-replay.json'), JSON.stringify({ passed: true, workingSamples: samples, duration: Date.now() - replayStart }))
  }
  terminalWindow.destroy(); terminalWindow = null
}
app.whenReady().then(async () => {
  savedClipboard = clipboard.readText()
  clipboard.writeText('DAILY_TODO_CLIPBOARD_FIXTURE')
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  window = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: {
    offscreen: true, preload: path.join(root, 'tests/renderer/fixtures/companion-preload.cjs'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    additionalArguments: ['--daily-todo-qa', '--companion-qa-port=' + server.address().port, '--companion-qa-workspace=' + workspace],
  } })
  window.webContents.on('console-message', (_event, level, message) => { if (level === 3 && !message.includes('QA_FILE_UNAVAILABLE')) errors.push(message) })
  await window.loadFile(renderer); await wait(ready, 'assistant ready')
  window.webContents.debugger.attach('1.3')
  await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  assert.equal(await js(`!!document.querySelector('.daily-todo-note')`), false, 'no unsolicited note')
  await click('[data-workspace-toggle]')
  await fill('select[aria-label="Agent"]', 'chat', 'select')
  await fill('.companion-composer textarea', 'Plan my DailyTodo')
  await js(`document.querySelector('.companion-composer textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`)
  await wait(`${noteText}?.includes('写好项目摘要')`, 'chat list appears in note')
  await wait(`JSON.parse(localStorage.getItem('dailyworkmate.dailyTodo.v1:personal') || '{}').text?.includes('写好项目摘要')`, 'conversation draft saved before any edit')
  assert.ok(await js(`document.querySelector('.companion-avatar').getBoundingClientRect().height < 160`))
  await click('.daily-todo-task input')
  assert.equal(await js(`document.querySelector('.daily-todo-task input').checked`), true)
  await click('.companion-message.is-user .copy-text-control button')
  assert.equal(clipboard.readText(), 'Plan my DailyTodo')
  await click('.companion-message:not(.is-user) .copy-text-control button')
  assert.equal(clipboard.readText().replace(/\r\n/g, '\n'), response)
  await click('.daily-todo-tools .copy-text-control button')
  assert.match(clipboard.readText(), /- \[x\] 写好项目摘要/)
  await sleep(1000); await reload()
  await wait(`document.querySelector('.daily-todo-task input')?.checked === true`, 'local completion persisted')
  await click('.daily-todo-footer button')
  await fill('#daily-todo-edit', '')
  assert.equal(await js(`document.querySelector('#daily-todo-edit').value`), '', 'empty draft stays empty')
  await fill('#daily-todo-edit', '- [ ] 本地便签保存与恢复\n- [x] 完成复制检查')
  await click('.daily-todo-editor button')
  await reload(); await wait(`${noteText}?.includes('本地便签保存与恢复')`, 'edited text persists')

  // Use a fresh conversation and no manual pin: the folder alone must trigger discovery.
  await js(`window.electronAPI.companion.addWorkspace()`)
  await click('button[aria-label="New chat"]')
  await wait(`document.querySelectorAll('.companion-message').length === 0`, 'new conversation is empty')
  await sleep(1000)
  await js(`new Promise((resolve, reject) => {
    const request = indexedDB.open('dailyworkmate.companion.history.v1', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction([...db.objectStoreNames], 'readwrite');
      for (const name of db.objectStoreNames) tx.objectStore(name).clear();
      tx.oncomplete = () => { db.close(); localStorage.removeItem('dailyworkmate.dailyTodo.v1:personal'); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  })`)
  await reload()
  assert.equal(await js(`document.querySelectorAll('.companion-message').length`), 0, 'folder trigger without chat keywords')
  await wait(`${noteText}?.includes('检查终端任务状态')`, 'authorized Daily folder automatically detected')
  assert.equal(await js(`document.querySelectorAll('.daily-todo-task input:disabled').length`), 4, 'read-only tasks stay disabled')
  assert.equal(await js(`document.querySelector('.daily-todo-rollover button').disabled`), true)
  assert.equal(await js(`document.querySelectorAll('.daily-todo-body table tbody tr').length`), 2, 'Markdown table')
  assert.equal(await js(`document.querySelector('.daily-todo-body strong').textContent`), '项目方案')
  assert.ok(await js(`!!document.querySelector('.daily-todo-body blockquote') && !!document.querySelector('.daily-todo-body li ul li')`), 'quotes and nested lists')
  assert.match(await js(`document.querySelector('.daily-todo-body pre code').textContent`), /这只是代码示例/)
  assert.equal(await js('window.TODO_UNSAFE'), undefined, 'raw HTML never executes')
  fs.writeFileSync(file, document.replace('检查终端任务状态', '自动刷新已收到'))
  await wait(`${noteText}?.includes('自动刷新已收到')`, 'file change automatically refreshes', 10000)
  failRead = true
  await click('.daily-todo-tools button[aria-label="Refresh daily notes"]')
  await wait(`document.querySelector('.daily-todo-warning')?.textContent.includes('QA_FILE_UNAVAILABLE')`, 'read error visible')
  assert.match(await js(noteText), /自动刷新已收到/, 'last content preserved on failure')
  failRead = false
  await click('.daily-todo-tools button[aria-label="Refresh daily notes"]')
  await wait(`!document.querySelector('.daily-todo-warning')`, 'retry recovers')
  grant = { ...grant, writable: true }
  await js(`window.electronAPI.companion.updateWorkspace('qa-folder', true)`)
  await reload(); await wait(`document.querySelectorAll('.daily-todo-task input:not(:disabled)').length === 4`, 'writable Markdown tasks')
  await click('.daily-todo-task input[aria-label="核对嵌套事项"]')
  await wait(`document.querySelector('.daily-todo-task input[aria-label="核对嵌套事项"]').checked`, 'nested task checked')
  assert.match(fs.readFileSync(file, 'utf8'), /  - \[x\] 核对嵌套事项/, 'checkbox saved to actual Markdown file')
  await reload(); await wait(`document.querySelector('.daily-todo-task input[aria-label="核对嵌套事项"]')?.checked`, 'file task survives reload')
  // An edit made before the next poll must conflict rather than silently overwrite it.
  const external = fs.readFileSync(file, 'utf8') + '\nExternal editor change.'
  fs.writeFileSync(file, external)
  await click('.daily-todo-task input[aria-label="核对嵌套事项"]')
  await wait(`document.querySelector('.daily-todo-warning')?.textContent.includes('changed elsewhere')`, 'external edit conflict visible')
  assert.equal(fs.readFileSync(file, 'utf8'), external)
  await wait(`${noteText}?.includes('External editor change.')`, 'conflict refreshes current content')
  // Starting from an older selection must copy today's latest file and avoid overwriting it.
  const yesterday = new Date(date); yesterday.setDate(yesterday.getDate() - 1)
  const oldDay = [yesterday.getFullYear(), String(yesterday.getMonth() + 1).padStart(2, '0'), String(yesterday.getDate()).padStart(2, '0')].join('-')
  const olderPath = path.join('Daily', oldDay + '.md')
  fs.writeFileSync(path.join(workspace, olderPath), '- [ ] Obsolete plan')
  await click('.daily-todo-tools button[aria-label="Refresh daily notes"]')
  await wait(`!![...document.querySelector('.daily-todo-source select').options].find(option => option.textContent.includes('${oldDay}'))`, 'old source discovered')
  await fill('.daily-todo-source select', JSON.stringify([grant.id, olderPath]), 'select')
  await wait(`${noteText}?.includes('Obsolete plan')`, 'older source selected')
  await click('.daily-todo-rollover button')
  await wait(`document.querySelector('.daily-todo-rollover [role="status"]')?.textContent.includes('(2).md')`, 'dated copy created and selected')
  assert.equal(fs.readFileSync(path.join(daily, day + ' (2).md'), 'utf8'), external, 'copy uses latest, not selected old file')
  assert.equal(fs.readFileSync(file, 'utf8'), external, 'original is unchanged')
  await wait(`${noteText}?.includes('External editor change.')`, 'new copy renders Markdown')
  await reload(); await wait(`document.querySelector('.daily-todo-source select')?.selectedOptions[0].textContent.includes('(2).md')`, 'new source selection persists')
  // Selecting regular interface text and invoking native copy has the expected result.
  await js(`(() => { const range = document.createRange(); range.selectNodeContents(document.querySelector('.page-header h1')); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); })()`)
  const selected = await js('getSelection().toString()')
  window.webContents.copy(); await sleep(100)
  assert.equal(clipboard.readText(), selected); assert.ok(selected.length)
  await js('getSelection().removeAllRanges()')
  for (const theme of ['light', 'dark']) {
    await js(`document.documentElement.dataset.theme='${theme}'; document.documentElement.classList.toggle('dark', '${theme}' === 'dark')`)
    for (const width of [1440, 540]) {
      window.setSize(width, 1000); await sleep(200)
      await js(`document.querySelector('.daily-todo-note').scrollIntoView({ block: 'center' })`)
      assert.equal(await js(`document.querySelector('main').scrollWidth > document.querySelector('main').clientWidth + 1`), false, 'no horizontal overflow')
      await screenshot('daily-' + theme + '-' + width)
    }
  }
  window.setSize(1440, 1000)
  await js(`document.documentElement.dataset.theme='light'; document.documentElement.classList.remove('dark')`)
  await click('button[aria-label="Switch to Chinese"]')
  await wait(`document.querySelector('.daily-todo-eyebrow')?.textContent.includes('把今天放在眼前')`, 'Chinese labels')
  await screenshot('daily-zh-desktop')
  await click('button[aria-label="Switch to English"]')
  await js(`[...document.querySelectorAll('.page-header button')].find(button => button.textContent.trim() === 'Hide avatar').click()`)
  await wait(`!document.querySelector('.companion-stage')`, 'avatar hidden')
  assert.equal(await js(`!!document.querySelector('.companion-stage')`), false)
  assert.equal(await js(`!!document.querySelector('.daily-todo-note')`), true, 'hiding avatar keeps note visible')
  await checkTerminal()
  assert.deepEqual(errors, [])
  fs.writeFileSync(path.join(scratch, 'report.json'), JSON.stringify({ passed: true, checks: ['chat trigger', 'folder trigger', 'compact avatar', 'local edit/check/reload', 'empty edit', 'Markdown tables/code/quotes/nesting', 'escaped HTML', 'read-only authorized files', 'writable nested Markdown tasks', 'external modification conflict', 'latest-source dated copy/collision/selection/reload', 'automatic refresh', 'read failure/retry', 'message/note/UI copy', 'xterm Ctrl+C/Shift+C/right click', 'SIGINT preserved', 'Codex idle/work/done in real xterm', 'light/dark desktop/narrow'], errors }, null, 2))
  console.log('PASS: Daily Todo and clipboard UI. Evidence: ' + scratch)
}).catch(async error => {
  console.error(error); process.exitCode = 1
  if (window && !window.isDestroyed()) { await screenshot('failure'); fs.writeFileSync(path.join(scratch, 'failure.txt'), await js('document.body.innerText')) }
}).finally(() => {
  if (savedClipboard !== undefined) clipboard.writeText(savedClipboard)
  terminalWindow?.destroy(); window?.destroy(); server.closeAllConnections(); server.close(); app.exit(process.exitCode || 0)
})
