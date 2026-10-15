// Run with Electron after npm run build. Uses an isolated profile and a real local PowerShell terminal.
const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..')
const scratch = fs.mkdtempSync(path.join(root, 'tmp', 'readme-'))
const workspace = path.join(scratch, 'DailyNotes')
const output = path.join(root, 'docs', 'screenshots')
fs.mkdirSync(workspace); fs.mkdirSync(output, { recursive: true })
fs.writeFileSync(path.join(workspace, 'weekly-plan.md'), '# Weekly plan\n\n- Review meeting notes\n- Prepare the project brief\n- Choose the next three actions\n')
fs.writeFileSync(path.join(workspace, 'meeting-notes.md'), '# Meeting notes\n\nA small, local documentation demo.\n')
app.setPath('userData', path.join(scratch, 'profile')); app.disableHardwareAcceleration()
buildSync({ stdin: { contents: "export { TerminalClient } from './src/main/terminal/client.ts'; export { DEFAULT_COMPANION_SETTINGS } from './src/shared/companion.ts';", resolveDir: root }, outfile: path.join(scratch, 'modules.cjs'), bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
const { TerminalClient, DEFAULT_COMPANION_SETTINGS } = require(path.join(scratch, 'modules.cjs'))
const config = { proxyHost: '127.0.0.1', proxyPort: 11434, apiKeys: [], enableApiKey: false, theme: 'light', language: 'zh-CN', modelMappings: {}, loadBalanceStrategy: 'round-robin' }
const snapshot = {
  settings: { ...DEFAULT_COMPANION_SETTINGS, model: 'Demo model', autoSpeak: false, speechEnabled: false },
  workspaces: [
    { id: 'notes', name: 'DailyNotes', path: 'C:\\Work\\DailyNotes', writable: true },
    { id: 'reference', name: 'Reference', path: 'C:\\Work\\Reference', writable: false },
  ], groups: [{ id: 'weekly', name: '每周工作', workspaceIds: ['notes', 'reference'] }],
  messages: [
    { id: 'demo-user', role: 'user', mode: 'chat', createdAt: Date.now() - 30000, content: '早上好，小伴。今天有项目评审、整理会议纪要和准备周报，帮我排一个轻量的工作计划。' },
    { id: 'demo-assistant', role: 'assistant', mode: 'chat', createdAt: Date.now(), model: 'Demo model', content: '早上好！今天可以先安排三件事：\n\n**09:00 · 项目评审**\n列出待确认的问题，记录关键决定。\n\n**11:00 · 会议纪要**\n整理结论、负责人和下一步行动。\n\n**15:00 · 起草周报**\n回顾本周进展，选出下周的优先事项。\n\n需要整理文件时，选择一个授权工作区，我们一起完成。' },
  ], home: 'companion', avatarUrl: '', avatarModelUrl: '', runtimeAvailable: true, claudeCode: { available: true, path: 'claude' },
}
fs.writeFileSync(path.join(scratch, 'demo.json'), JSON.stringify({ config, snapshot, version: require('../package.json').version }))
let window, manager
const errors = []
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const js = async code => { try { return await window.webContents.executeJavaScript(code, true) } catch (error) { throw new Error(error.message + '\nRenderer command: ' + code.slice(0,200)) } }
const button = text => `[...document.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(text)})`
async function wait(code, label) { for (let n = 0; n < 150; n++) { if (await js(code)) return; await sleep(100) } throw new Error('Timed out: ' + label) }
async function capture(name) {
  await sleep(500)
  assert.equal(await js('document.documentElement.scrollWidth > innerWidth + 1'), false, 'no horizontal overflow')
  window.webContents.invalidate(); await sleep(150)
  fs.writeFileSync(path.join(output, name + '.png'), (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG())
}
app.whenReady().then(async () => {
  manager = new TerminalClient({ home: path.join(scratch, 'terminal'), entry: path.join(root, 'out/main/terminalHost.js'), helper: path.join(root, 'scripts/companion-pty-host.cjs'), ptyModule: path.join(root, 'node_modules/node-pty'), context: async () => ({ workspaces: [], groups: [], persona: '', proxy: config }) })
  for (const [name, operation] of Object.entries(manager.api(async () => workspace))) ipcMain.handle('readme:terminal:' + name, async (_event, ...args) => { const result = await operation(...args); return result === undefined ? result : JSON.parse(JSON.stringify(result).split(JSON.stringify(workspace).slice(1, -1)).join('C:\\\\Work\\\\DailyNotes')) })
  window = new BrowserWindow({ show: false, width: 1440, height: 940, useContentSize: true, webPreferences: { offscreen: true, sandbox: false, preload: path.join(__dirname, 'readme-preload.cjs'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, additionalArguments: ['--readme-data=' + path.join(scratch, 'demo.json')] } })
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message) })
  await window.loadFile(path.join(root, 'out/renderer/index.html'))
  await wait(`!!document.querySelector('[data-companion-ready="true"]')`, 'assistant loaded')
  await wait('document.body.textContent.includes("DailyWorkMate") && document.body.textContent.includes("起草周报")', 'demo conversation')
  await js("document.querySelector('.companion-messages').scrollTop = 0"); await capture('assistant')
  await js(`document.querySelector('[aria-label="文件夹权限"]').click()`)
  await wait('document.querySelectorAll("[data-authorized-folder]").length === 2', 'workspace access')
  await capture('workspaces')
  await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
  await sleep(200)
  // The directory selector and tabs are the production terminal UI, backed by an actual PTY.
  await js(`${button('终端')}.click()`)
  await wait('!!document.querySelector(".unified-terminal")', 'terminal panel')
  const api = manager.api(async () => workspace)
  await api.create({ id: '11111111-1111-4111-8111-111111111111', kind: 'powershell', directory: workspace, cols: 110, rows: 24 })
  await api.create({ id: '22222222-2222-4222-8222-222222222222', kind: 'cmd', directory: workspace, cols: 110, rows: 24 })
  await api.select('11111111-1111-4111-8111-111111111111')
  await js(`${button('聊天')}.click()`); await sleep(150); await js(`${button('终端')}.click()`)
  await wait('document.querySelectorAll(".unified-terminal-tab").length === 2 && !!document.querySelector(".xterm-helper-textarea")', 'two terminal tabs attached')
  await sleep(1600)
  // Use an explicit demo prompt so the screenshot contains no personal account or absolute machine paths.
  await api.write('11111111-1111-4111-8111-111111111111', "function global:prompt { 'PS DailyNotes> ' }; Clear-Host; Write-Output 'DailyWorkMate / local terminal'; Get-ChildItem -Name; Get-Content .\\weekly-plan.md\r")
  await sleep(1000)
  await wait('document.querySelector(".xterm-rows")?.textContent.includes("Weekly plan")', 'real shell output rendered')
  await capture('terminal')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ screenshots: ['assistant.png', 'workspaces.png', 'terminal.png'], demoData: true, realTerminal: true }))
}).catch(error => { console.error(error); console.error(errors); process.exitCode = 1 }).finally(async () => {
  window?.destroy()
  if (manager) {
    try { await manager.command('preferences', { preferences: { restoreOnStartup: false, keepRunningOnExit: false } }); const state = await manager.command('state'); for (const session of state.sessions) await manager.command('close', { id: session.id }); await manager.detach() } catch (error) { console.error('Terminal cleanup:', error); process.exitCode = 1 }
  }
  app.exit(process.exitCode || 0)
})
