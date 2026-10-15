// Real terminal host + ConPTY: the PowerShell tab runs PowerShell 7 when installed, with history predictions and Up-arrow recall.
// Test commands contain "token", so PSReadLine keeps them in memory only and never writes them to the user's history file.
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..')
const scratch = fs.mkdtempSync(path.join(root, 'tmp', 'terminal-powershell-'))
// Like the packaged app started from Explorer: the system module path, not this shell's.
if (process.platform === 'win32') process.env.PSModulePath = 'C:\\Program Files\\WindowsPowerShell\\Modules;C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\Modules'
buildSync({ entryPoints: [path.join(root, 'src/main/terminal/client.ts')], outfile: path.join(scratch, 'client.cjs'), bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
buildSync({ entryPoints: [path.join(root, 'src/main/terminal/shells.ts')], outfile: path.join(scratch, 'shells.cjs'), bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
const { TerminalClient } = require(path.join(scratch, 'client.cjs'))
const { findPowerShell } = require(path.join(scratch, 'shells.cjs'))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const manager = new TerminalClient({ home: path.join(scratch, 'terminal'), entry: path.join(root, 'out/main/terminalHost.js'), helper: path.join(root, 'scripts/companion-pty-host.cjs'),
  ptyModule: path.join(root, 'node_modules/node-pty'), executable: require('electron'),
  context: async () => ({ workspaces: [], groups: [], persona: '', executable: path.join(scratch, 'missing.exe'), proxy: { proxyHost: '127.0.0.1', proxyPort: 1, enableApiKey: false, apiKeys: [] } }) })
const plain = text => text.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g, '')
;(async () => {
  const shell = findPowerShell()
  if (!shell) { console.log('SKIP: PowerShell is not installed'); return }
  await manager.synchronize()
  const id = randomUUID()
  await manager.command('create', { input: { id, kind: 'powershell', directory: scratch, cols: 140, rows: 30 } })
  let cursor = 0, all = ''
  const read = async () => { const next = await manager.command('poll', { id, cursor }); cursor = next.cursor; all += next.data; if (next.session.status === 'error') throw new Error(next.session.error); return next.data }
  const until = async (check, label, ms = 30000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error('Timed out: ' + label + '\n' + plain(all).slice(-800)); await sleep(150); await read() } }
  const send = data => manager.command('write', { id, data })
  await until(() => all.length > 0, 'PowerShell started'); await sleep(2500); await read()
  await send("Write-Host ('PROBE|' + $PSVersionTable.PSVersion + '|' + (Get-Module PSReadLine).Version + '|' + $(try { (Get-PSReadLineOption).PredictionSource } catch { 'none' }) + '|') # token\r")
  const output = /PROBE\|(\d[\d.]*)\|(\d[\d.]*)\|(\w*)\|/
  await until(() => output.test(plain(all)), 'PowerShell version probe')
  const [, version, readline, prediction] = plain(all).match(output)
  console.log('terminal runs ' + path.basename(shell.file) + ' ' + version + ', PSReadLine ' + readline + ', predictions: ' + prediction)
  if (!shell.modern) { console.log('PowerShell 7 is not installed; Windows PowerShell has no predictions'); return }
  assert.match(version, /^7\./)
  assert.match(prediction, /History/)

  const marker = 'DAILYWORKMATE_PREDICT_QA_' + Math.floor(Math.random() * 1e6)
  await send(`Write-Output 'qa token ${marker}'\r`)
  await until(() => plain(all).includes('qa token ' + marker + '\r') || plain(all).split('qa token ' + marker).length > 2, 'history entry')
  await sleep(800); await read()
  // Typing the start of that command shows the rest of it as an inline suggestion.
  const before = all.length
  await send(`Write-Output 'qa token ${marker.slice(0, 18)}`)
  await until(() => plain(all.slice(before)).includes(marker.slice(18)), 'inline history prediction', 10000)
  // Escape clears the line; Up recalls the previous command.
  await send('\x1b'); await sleep(400); await read()
  const recall = all.length
  await send('\x1b[A')
  await until(() => plain(all.slice(recall)).includes(marker), 'Up-arrow history recall', 10000)
  await send('\x1b'); await sleep(200)
  console.log('PASS: PowerShell 7 in the Terminal tab shows history predictions while typing and recalls history with Up')
})().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  try { const state = await manager.command('state'); for (const session of state.sessions) await manager.command('close', { id: session.id }); await manager.detach() } catch { /* host already gone */ }
  console.log('QA artifacts: ' + scratch)
})
