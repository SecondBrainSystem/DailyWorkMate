// Exercise Electron's actual before-quit/will-quit sequence with an isolated terminal host.
const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..')
const scratch = fs.mkdtempSync(path.join(root, 'tmp', 'application-quit-'))
app.setPath('userData', path.join(scratch, 'profile'))
buildSync({ stdin: { contents: "export { TerminalClient } from './src/main/terminal/client.ts'; export { createQuitController } from './src/main/quit.ts';", resolveDir: root }, outfile: path.join(scratch, 'services.cjs'), bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
const { TerminalClient, createQuitController } = require(path.join(scratch, 'services.cjs'))
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
let manager, hostPid, childPid, cleaned = false, prevented = 0
app.on('before-quit', createQuitController({ confirm: async () => true, cleanup: async () => { prevented++; await manager.detach(); cleaned = true }, commit: () => app.quit(), cancel: error => { console.error(error); app.exit(1) } }))
app.on('will-quit', () => {
  try {
    assert.ok(cleaned); assert.equal(prevented, 1)
    assert.equal(alive(childPid), false, 'ordinary child must be gone before Electron will-quit')
    assert.equal(alive(hostPid), false, 'host must be gone before Electron will-quit')
    fs.writeFileSync(path.join(scratch, 'report.json'), JSON.stringify({ passed: true, childPid, hostPid, cleaned, prevented }, null, 2))
    console.log('PASS: Electron waits for child and terminal host exit before will-quit')
  } catch (error) { console.error(error); app.exit(1) }
})
app.whenReady().then(async () => {
  const node = execFileSync('where.exe', ['node.exe'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)[0]
  fs.writeFileSync(path.join(scratch, 'child.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(path.join(scratch, 'child.pid'))},String(process.pid));setInterval(()=>{},1000)`)
  manager = new TerminalClient({ home: path.join(scratch, 'terminal'), entry: path.join(root, 'out/main/terminalHost.js'), helper: path.join(root, 'scripts/companion-pty-host.cjs'), ptyModule: path.join(root, 'node_modules/node-pty'), context: async () => ({ workspaces: [], groups: [], persona: '', executable: '' }) })
  const id = randomUUID()
  await manager.command('create', { input: { id, kind: 'cmd', directory: scratch, cols: 90, rows: 25 } })
  await manager.command('write', { id, data: '"' + node + '" "' + path.join(scratch, 'child.cjs') + '"\r' })
  const deadline = Date.now() + 20000
  while (!fs.existsSync(path.join(scratch, 'child.pid'))) { if (Date.now() > deadline) throw new Error('Child startup timeout'); await new Promise(resolve => setTimeout(resolve, 100)) }
  childPid = Number(fs.readFileSync(path.join(scratch, 'child.pid'), 'utf8'))
  hostPid = JSON.parse(fs.readFileSync(path.join(scratch, 'terminal', 'host.json'), 'utf8')).pid
  console.log('QA artifacts: ' + scratch)
  app.quit(); app.quit()
}).catch(async error => { console.error(error); await manager?.detach(); app.exit(1) })
