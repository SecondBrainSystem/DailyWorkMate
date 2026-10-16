// Real ordinary children + isolated psmux server. Never touches the user's psmux registry.
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { spawn, execFileSync } = require('node:child_process')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..')
const scratch = fs.mkdtempSync(path.join(root, 'tmp', 'terminal-exit-'))
buildSync({ stdin: { contents: "export { stopProcessTree } from './src/main/companion/processTree.ts'; export { discoverPsmux, closePsmux } from './src/main/terminal/psmux.ts'; export { createQuitController } from './src/main/quit.ts';", resolveDir: root }, outfile: path.join(scratch, 'services.cjs'), bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
const { stopProcessTree, discoverPsmux, closePsmux, createQuitController } = require(path.join(scratch, 'services.cjs'))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
async function until(check, label) { const deadline = Date.now() + 30000; while (!await check()) { if (Date.now() > deadline) throw new Error(label); await sleep(100) } }
const registry = path.join(scratch, '.psmux')
const psmux = execFileSync('where.exe', ['psmux.exe'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)[0]
const config = path.join(scratch, 'empty.conf'); fs.writeFileSync(config, 'set -g default-shell cmd\nset -g default-command "cmd /Q"\n')
fs.writeFileSync(path.join(scratch, 'beat.cjs'), `require('node:fs').writeFileSync(process.argv[2],String(process.pid));setInterval(()=>{},1000)`)
fs.writeFileSync(path.join(scratch, 'owner.cjs'), `const {spawn,execFileSync}=require('node:child_process');const path=require('node:path');const base=__dirname;spawn(process.execPath,[path.join(base,'beat.cjs'),path.join(base,'ordinary.pid')],{windowsHide:true,stdio:'ignore'});execFileSync(process.env.QA_PSMUX,['-f',path.join(base,'empty.conf'),'new-session','-d','-s','quit-qa','--',process.execPath,path.join(base,'beat.cjs'),path.join(base,'mux.pid')],{windowsHide:true,timeout:15000,stdio:'pipe'});require('node:fs').writeFileSync(path.join(base,'ready'),'ok');setInterval(()=>{},1000)`)
let owner, sessions = [], ordinaryPid, muxPid
;(async () => {
  owner = spawn(process.execPath, [path.join(scratch, 'owner.cjs')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, QA_PSMUX: psmux, PSMUX_DATA_DIR: registry, PSMUX_CONFIG_FILE: config, USERPROFILE: scratch, HOME: scratch } })
  let log = ''; owner.stderr.on('data', chunk => { log += chunk })
  await until(() => { if (owner.exitCode != null) throw new Error(log); return fs.existsSync(path.join(scratch, 'ready')) && fs.existsSync(path.join(scratch, 'mux.pid')) }, 'isolated psmux startup')
  ordinaryPid = Number(fs.readFileSync(path.join(scratch, 'ordinary.pid'), 'utf8')); muxPid = Number(fs.readFileSync(path.join(scratch, 'mux.pid'), 'utf8'))
  sessions = await discoverPsmux([registry])
  assert.ok(sessions.some(session => session.name === 'quit-qa'))
  let choice = 'cancel', committed = 0, failure
  const quit = createQuitController({ confirm: async () => { if (choice === 'cancel') return false; if (choice === 'close') await closePsmux(sessions); return true }, cleanup: async () => { await stopProcessTree(owner.pid) }, commit: () => { committed++ }, cancel: error => { failure = error } })
  quit({ preventDefault() {} }); await sleep(200)
  assert.ok(alive(ordinaryPid) && alive(muxPid)); assert.equal(committed, 0)
  choice = 'keep'; quit({ preventDefault() {} })
  await until(() => { if (failure) throw failure; return committed === 1 }, 'awaited quit')
  assert.equal(alive(ordinaryPid), false, 'ordinary child stopped before exit committed')
  assert.equal(alive(owner.pid), false, 'owner stopped before exit committed')
  assert.ok(alive(muxPid), 'retained psmux pane survives cleanup of its original parent')
  assert.ok((await discoverPsmux([registry])).some(session => session.name === 'quit-qa'))
  await closePsmux(sessions)
  await until(() => !alive(muxPid), 'confirmed psmux close stops its pane')
  assert.deepEqual(await discoverPsmux([registry]), [])
  fs.writeFileSync(path.join(scratch, 'report.json'), JSON.stringify({ passed: true, checks: ['cancel preserves all children', 'ordinary child tree exits before commit', 'keep preserves real detached psmux pane', 'confirmed close stops psmux pane'], ordinaryPid, muxPid }, null, 2))
  console.log('PASS: awaited process-tree exit and real psmux cancel/keep/close semantics')
})().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  try { await closePsmux(await discoverPsmux([registry])); if (owner && alive(owner.pid)) await stopProcessTree(owner.pid) } catch (error) { console.error('Cleanup:', error.message) }
  console.log('QA artifacts: ' + scratch)
})
