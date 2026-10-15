// Real OS folder drops, disk grants and terminal host in a hidden, isolated Electron window.
const { app, BrowserWindow, ipcMain } = require('electron')
const { buildSync } = require('esbuild')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const root = path.resolve(__dirname, '..')
const packagedArgument = process.argv.find(arg => arg.startsWith('--packaged='))
const packaged = packagedArgument ? path.resolve(packagedArgument.slice('--packaged='.length)) : null
const scratch = fs.mkdtempSync(path.join(root, 'tmp', 'folder-drop-ui-'))
const folders = ['中文 Folder A', 'Folder B'].map(name => path.join(scratch, name))
folders.forEach(directory => fs.mkdirSync(directory))
const child = path.join(folders[0], 'Nested folder'); fs.mkdirSync(child)
const file = path.join(scratch, 'file.txt'); fs.writeFileSync(file, 'not a folder')
app.on('window-all-closed', () => {})
app.setPath('userData', path.join(scratch, 'profile')); app.disableHardwareAcceleration()
process.env.DAILYWORKMATE_COMPANION_HOME = scratch
buildSync({ stdin: { contents: "export { CompanionStorage } from './src/main/companion/storage.ts'; export { TerminalClient } from './src/main/terminal/client.ts'; export { openLocalDirectory } from './src/main/companion/folders.ts'; export { resolveWorkspacePath } from './src/main/companion/workspaces.ts';", resolveDir: root }, outfile: path.join(scratch, 'services.cjs'), bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
const { CompanionStorage, TerminalClient, openLocalDirectory, resolveWorkspacePath } = require(path.join(scratch, 'services.cjs'))
let window, manager
const storage = new CompanionStorage()
const opened = [], errors = []
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const js = code => window.webContents.executeJavaScript(code, true)
const button = text => `[...(document.querySelector('[data-folder-drop-dialog]') || document).querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(text)})`
async function wait(code, label, timeout = 20000) { const end = Date.now() + timeout; while (!(await js(code))) { if (Date.now() > end) throw new Error('Timed out: ' + label); await sleep(100) } }
async function click(code) { await wait(`!!(${code}) && !(${code}).disabled`, 'clickable control: ' + code); await js(`(${code}).click()`); await sleep(150) }
async function select(label, value) { await js(`(() => { const el=document.querySelector('select[aria-label=${JSON.stringify(label)}]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('change',{bubbles:true})); })()`); await sleep(100) }
async function fill(label, value) { await js(`(() => { const el=document.querySelector('input[aria-label=${JSON.stringify(label)}]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true})); })()`); await sleep(100) }
async function drop(paths, selector) {
  const point = await js(`(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+Math.min(100,r.height/2)} })()`)
  for (const type of ['dragEnter', 'dragOver', 'drop']) await window.webContents.debugger.sendCommand('Input.dispatchDragEvent', { type, ...point, data: { items: [], files: paths, dragOperationsMask: 1 } })
  await wait(`!!document.querySelector('[data-folder-drop-dialog]')`, 'drop dialog')
  await wait(`!document.querySelector('[data-folder-drop-dialog] [role="status"]')`, 'folder inspection')
}
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*')
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return }
  res.end(JSON.stringify(req.url === '/v1/models' ? { data: [{ id: 'qa-model' }] } : { model: 'qa-model', verified: true }))
})
app.whenReady().then(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  window = new BrowserWindow({ show: false, width: 1360, height: 900, webPreferences: { offscreen: true, preload: path.join(root, 'tests/renderer/fixtures/companion-preload.cjs'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    additionalArguments: ['--unified-terminal', '--companion-qa-port=' + server.address().port] } })
  window.webContents.on('console-message', (_event, level, message) => { if (level === 3) errors.push(message) })
  manager = new TerminalClient({ home: path.join(scratch, 'terminal'), entry: packaged ? path.join(packaged, 'resources/app.asar/out/main/terminalHost.js') : path.join(root, 'out/main/terminalHost.js'), helper: packaged ? path.join(packaged, 'resources/companion-terminal/companion-pty-host.cjs') : path.join(root, 'scripts/companion-pty-host.cjs'), ptyModule: packaged ? path.join(packaged, 'resources/companion-terminal/node-pty') : path.join(root, 'node_modules/node-pty'), executable: packaged ? path.join(packaged, 'DailyWorkMate.exe') : undefined,
    context: async () => ({ workspaces: (await storage.get()).workspaces, groups: (await storage.get()).groups, persona: 'QA', executable: '', proxy: { proxyHost: '127.0.0.1', proxyPort: server.address().port, enableApiKey: false, apiKeys: [] } }) })
  for (const [name, operation] of Object.entries(manager.api(async () => folders[0]))) ipcMain.handle('qa:terminal:' + name, (_event, ...args) => operation(...args))
  const open = directory => openLocalDirectory(directory, async checked => { opened.push(checked); return '' })
  for (const [name, operation] of Object.entries({ inspectFolders: paths => storage.inspectFolders(paths), importWorkspaces: async input => { await storage.importWorkspaces(input); return storage.get() },
    openWorkspace: async (id, relative = '') => open(await resolveWorkspacePath(await storage.grant(id), relative)),
    openTerminalDirectory: async id => { const state = await manager.command('state'); const session = state.sessions.find(item => item.id === id); if (!session) throw new Error('Closed terminal'); return open(session.directory) },
  })) ipcMain.handle('qa:folder:' + name, (_event, ...args) => operation(...args))
  await window.loadFile(packaged ? path.join(packaged, 'resources/app.asar/out/renderer/index.html') : path.join(root, 'out/renderer/index.html'))
  window.webContents.debugger.attach('1.3')
  await wait(`!!document.querySelector('[data-companion-ready="true"]')`, 'assistant')
  assert.equal(await js(`document.querySelector('.companion-name').textContent.trim()`), 'DailyWorkMate')
  await click(`document.querySelector('[aria-label="Edit assistant name"]')`)
  await fill('Assistant name', '我的章鱼助手')
  await click(button('Save settings'))
  await wait(`document.querySelector('.companion-name').textContent.includes('我的章鱼助手')`, 'custom name')
  await window.reload(); await wait(`!!document.querySelector('[data-companion-ready="true"]')`, 'reload')
  assert.equal(await js(`document.querySelector('.companion-name').textContent.trim()`), '我的章鱼助手')
  await click(button('Work'))
  await drop(folders, '.work-sessions')
  assert.equal((await storage.get()).workspaces.length, 0, 'dropping alone does not grant access')
  assert.equal(await js(`document.querySelector('select[aria-label="中文 Folder A dropped access"]').value`), 'read')
  await select('Folder B dropped access', 'write')
  await select('Dropped folder group', '__new__'); await fill('New group name', 'Daily tasks')
  await sleep(200); fs.writeFileSync(path.join(scratch, 'folder-access.png'), (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG())
  await click(button('Confirm access'))
  await wait(`!!document.querySelector('[data-authorized-group]')`, 'authorized folder panel')
  const state = await storage.get()
  assert.deepEqual(state.workspaces.map(folder => folder.writable), [false, true]); assert.equal(state.groups[0].name, 'Daily tasks')
  await click(`document.querySelector('[aria-label="Open folder 中文 Folder A"]')`)
  assert.equal(opened.at(-1), folders[0])
  // The folder-access dialog accepts drops too; duplicate folders preserve permissions and IDs.
  await drop([folders[1]], '[aria-label="Authorized folder management"]')
  assert.equal(await js(`document.querySelector('select[aria-label="Folder B dropped access"]').value`), 'write')
  await click(button('Cancel'))
  assert.deepEqual((await storage.get()).workspaces, state.workspaces)
  // A file must never open as a document or become an authorized folder.
  await drop([file], '.work-sessions')
  await wait(`!!document.querySelector('[data-folder-drop-dialog] [role="alert"]')`, 'file rejected')
  assert.deepEqual((await storage.get()).workspaces, state.workspaces)
  await click(button('Cancel'))
  // A bound Work tab opens its actual selected subfolder even if no model has been picked yet.
  const workState = { open: [{ id: 'qa-work', workspaceId: state.workspaces[0].id, groupId: '', accessScope: 'folder', relativePath: 'Nested folder', model: '', sessionId: '', createdAt: 1, usedAt: 1 }], activeId: 'qa-work', recent: [], model: '' }
  await js(`localStorage.setItem('dailyworkmate.companion.workSessions.v2', ${JSON.stringify(JSON.stringify(workState))})`)
  await window.reload(); await wait(`!!document.querySelector('[aria-label="Open current workspace folder"]')`, 'work folder button')
  await click(`document.querySelector('[aria-label="Open current workspace folder"]')`)
  assert.equal(opened.at(-1), child)
  await click(button('Terminal'))
  await wait(`!!document.querySelector('.unified-terminal')`, 'terminal panel')
  await drop([folders[0]], '.unified-terminal')
  await wait(`document.querySelectorAll('select[aria-label="Dropped terminal shell"] option').length > 0`, 'shell choices')
  await select('Dropped terminal shell', 'powershell'); await click(button('Open terminal'))
  await wait(`!!document.querySelector('.unified-terminal-host .xterm-helper-textarea') && document.querySelector('.unified-terminal-footer')?.textContent.includes('Running')`, 'dropped terminal running')
  const session = (await manager.command('state')).sessions[0]
  assert.equal(session.directory, folders[0])
  await manager.command('write', { id: session.id, data: "Set-Location -LiteralPath '" + child.replaceAll("'", "''") + "'\r" })
  await wait(`document.querySelector('.terminal-open-folder')?.textContent.includes('Nested folder')`, 'current directory follows cd')
  await click(`document.querySelector('[aria-label="Open current terminal folder"]')`)
  assert.equal(opened.at(-1), child)
  await drop([folders[1]], '.unified-terminal-host')
  await click(`[...document.querySelectorAll('[data-folder-drop-dialog] label')].find(el => el.textContent.includes('Add to authorized workspaces')).querySelector('input')`)
  await wait(`!!document.querySelector('select[aria-label="Folder B dropped access"]')`, 'terminal drop workspace choice')
  await click(button('Cancel'))
  assert.equal((await manager.command('state')).sessions.length, 1, 'cancelled drop does not start another shell')
  window.setSize(540, 900); await sleep(300)
  assert.equal(await js('document.documentElement.scrollWidth > innerWidth + 1'), false)
  assert.deepEqual(errors, [])
  console.log('PASS: native multi-folder drops, access/group confirmation, cancel/file rejection, workspace subfolder opening, terminal drop choices, current directory tracking and editable persistent name')
  console.log(scratch)
}).catch(async error => { console.error(error); console.error('Scratch:', scratch); if (window && !window.isDestroyed()) { fs.writeFileSync(path.join(scratch, 'failure.html'), await js('document.body.innerHTML')); fs.writeFileSync(path.join(scratch, 'failure.png'), (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG()) }; process.exitCode = 1 }).finally(async () => {
  if (window && !window.isDestroyed()) window.destroy()
  if (manager) { try { for (const session of (await manager.command('state')).sessions) await manager.command('close', { id: session.id }); await manager.detach() } catch (error) { console.error(error); process.exitCode = 1 } }
  server.close(); app.exit(process.exitCode || 0)
})
