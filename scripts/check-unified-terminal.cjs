// Real ConPTY + a detached host. Profiles and model replies are isolated under tmp/.
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { fork } = require('node:child_process')
const http = require('node:http')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..')
const packagedArgument = process.argv.find(arg => arg.startsWith('--packaged='))
const packaged = packagedArgument ? path.resolve(packagedArgument.slice('--packaged='.length)) : null
const ownerHome = process.argv[2] === '--owner' ? process.argv[3] : null
const scratch = ownerHome || fs.mkdtempSync(path.join(root, 'tmp', 'unified-terminal-'))
const clientFile = path.join(scratch, 'client.cjs')
if (!ownerHome) buildSync({ entryPoints: [path.join(root, 'src/main/terminal/client.ts')], outfile: clientFile, bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
const { TerminalClient } = require(clientFile)
const workspace = path.join(scratch, 'workspace')
fs.mkdirSync(path.join(workspace, '子目录'), { recursive: true })
fs.writeFileSync(path.join(workspace, 'hello.txt'), 'UNIFIED_GUARDED_FILE_QA')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let context = { workspaces: [{ id: 'qa', name: 'Terminal QA', path: workspace, writable: false }], groups: [], persona: 'QA companion. Reply in Chinese.',
  proxy: { proxyHost: '127.0.0.1', proxyPort: 1, enableApiKey: false, apiKeys: [] }, executable: packaged ? path.join(packaged, 'resources/companion-runtime/opencode.exe') : path.join(root, 'companion/runtime/opencode-v2/node_modules/@opencode/cli/bin/opencode.exe') }
const options = { home: path.join(scratch, 'terminal'), entry: packaged ? path.join(packaged, 'resources/app.asar/out/main/terminalHost.js') : path.join(root, 'out/main/terminalHost.js'),
  helper: packaged ? path.join(packaged, 'resources/companion-terminal/companion-pty-host.cjs') : path.join(root, 'scripts/companion-pty-host.cjs'),
  ptyModule: packaged ? path.join(packaged, 'resources/companion-terminal/node-pty') : path.join(root, 'node_modules/node-pty'), executable: packaged ? path.join(packaged, 'DailyWorkMate.exe') : require('electron'), context: async () => context }
const client = () => new TerminalClient(options)
const create = (kind, directory = workspace, extra = {}) => ({ id: randomUUID(), kind, directory, cols: 100, rows: 30, ...extra })
async function until(check, label, timeout = 30000) {
  const end = Date.now() + timeout
  while (true) { const result = await check(); if (result) return result; if (Date.now() > end) throw new Error('Timed out: ' + label); await sleep(100) }
}
async function output(manager, id, pattern, timeout) {
  return until(async () => { const next = await manager.command('poll', { id, cursor: 0 }); if (next.session.status === 'error') throw new Error(next.session.error); return pattern.test(next.data) ? next : false }, String(pattern), timeout)
}
async function send(manager, id, data) { await manager.command('write', { id, data }) }
if (ownerHome) {
  ;(async () => {
    const manager = client()
    await manager.synchronize()
    const input = create('cmd')
    await manager.command('create', { input })
    await output(manager, input.id, />/)
    await send(manager, input.id, 'set DAILYWORKMATE_TERMINAL_QA=SESSION_SURVIVED\r')
    await send(manager, input.id, 'echo READY_REAL_OWNER\r')
    await output(manager, input.id, /READY_REAL_OWNER/)
    await manager.command('preferences', { preferences: { restoreOnStartup: true, keepRunningOnExit: true } })
    process.send({ id: input.id, ownerPid: process.pid, hostPid: JSON.parse(fs.readFileSync(path.join(options.home, 'host.json'), 'utf8')).pid })
    process.disconnect(); process.exit(0)
  })().catch(error => { console.error(error); process.exit(1) })
} else {
  let manager, nativePoll, nativeOutput = '', modelRequests = []
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: 'qa-model' }] })); return }
      let raw = ''; for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw); modelRequests.push(body)
      const done = body.messages.some(message => message.role === 'tool')
      const delta = done ? { content: 'UNIFIED_OPENCODE_COMPLETE: UNIFIED_GUARDED_FILE_QA' } : { tool_calls: [{ index: 0, id: 'qa_read', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: path.join(workspace, 'hello.txt') }) } }] }
      res.setHeader('Content-Type', 'text/event-stream')
      res.write('data: ' + JSON.stringify({ id: 'qa', object: 'chat.completion.chunk', created: 1, model: 'qa-model', choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n')
      res.write('data: ' + JSON.stringify({ id: 'qa', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: done ? 'stop' : 'tool_calls' }] }) + '\n\n')
      res.end('data: [DONE]\n\n')
    } catch (error) { res.writeHead(500).end(error.message) }
  })
  const checks = []
  ;(async () => {
    const owner = fork(__filename, ['--owner', scratch, ...(packagedArgument ? [packagedArgument] : [])], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true })
    let ownerLog = ''; owner.stderr.on('data', chunk => { ownerLog += chunk })
    const info = await new Promise((resolve, reject) => { owner.once('message', resolve); owner.once('exit', code => { if (code) reject(new Error(ownerLog)) }); owner.once('error', reject) })
    await new Promise(resolve => owner.exitCode === null ? owner.once('exit', resolve) : resolve())
    await until(() => !fs.existsSync(path.join(options.home, 'host.json')), 'host stops after its owner exits', 30000)
    manager = client()
    let state = await manager.synchronize()
    const descriptor = JSON.parse(fs.readFileSync(path.join(options.home, 'host.json'), 'utf8'))
    assert.notEqual(descriptor.pid, info.hostPid, 'ordinary terminal hosts must stop when their owner exits')
    const status = headers => new Promise((resolve, reject) => { const req = http.request({ hostname: '127.0.0.1', port: descriptor.port, path: '/command', method: 'POST', headers }, res => { res.resume(); resolve(res.statusCode) }); req.on('error', reject); req.end('{"action":"ping"}') })
    assert.equal(await status({}), 403)
    assert.equal(await status({ Authorization: 'Bearer ' + descriptor.token, Origin: 'https://untrusted.invalid' }), 403)
    checks.push('Local host rejects unauthenticated clients and browser-origin requests')
    assert.equal(state.sessions[0].id, info.id)
    await output(manager, info.id, /\x1b\]133;A(?:\x07|\x1b\\)/)
    const beforeQuery = (await manager.command('poll', { id: info.id, cursor: 0 })).cursor
    await send(manager, info.id, 'echo %DAILYWORKMATE_TERMINAL_QA% & echo AFTER_TRUE_OWNER_EXIT\r')
    await until(async () => {
      const next = await manager.command('poll', { id: info.id, cursor: beforeQuery })
      fs.writeFileSync(path.join(scratch, 'live-environment-output.txt'), next.data)
      if (!next.data.includes('AFTER_TRUE_OWNER_EXIT')) return false
      assert.ok(!next.data.includes('SESSION_SURVIVED'), 'old process environment must not survive exit')
      return true
    }, 'clean CMD after real owner exit')
    checks.push('Owner exit stops ordinary processes even with a legacy keep-running preference')
    await manager.command('resize', { id: info.id, cols: 85, rows: 25 })
    const ps = create('powershell')
    state = await manager.command('create', { input: ps })
    await output(manager, ps.id, /PS .*?>/)
    // "# token" keeps test commands out of the user's PowerShell history file (PSReadLine stores such lines in memory only).
    await send(manager, ps.id, "Write-Output ('中文输入成功:' + $PID) # token\r")
    const first = await output(manager, ps.id, /中文输入成功:\d+/)
    assert.match(first.data, /\x1b\]133;A(?:\x07|\x1b\\)/, 'PowerShell reports a real shell prompt separately from its directory')
    const firstPid = Number(first.data.match(/中文输入成功:(\d+)/)[1])
    await send(manager, ps.id, "Set-Location -LiteralPath '.\\子目录'; Write-Output 'CWD_READY' # token\r")
    await until(async () => (await manager.command('state')).sessions.find(item => item.id === ps.id)?.directory === path.join(workspace, '子目录'), 'PowerShell current directory')
    checks.push('PowerShell Unicode input, native PID, current directory and resize')
    await manager.command('preferences', { preferences: { restoreOnStartup: true, keepRunningOnExit: false } })
    await manager.detach(); await sleep(1200)
    manager = client(); state = await manager.synchronize()
    assert.equal(state.sessions.length, 2)
    assert.equal(state.sessions.find(item => item.id === ps.id).directory, path.join(workspace, '子目录'))
    await output(manager, ps.id, /PS .*?>/)
    await send(manager, ps.id, "Write-Output ('RESTORED_PID:' + $PID) # token\r")
    const restored = await output(manager, ps.id, /RESTORED_PID:\d+/)
    assert.notEqual(Number(restored.data.match(/RESTORED_PID:(\d+)/)[1]), firstPid)
      assert.doesNotMatch(restored.data, /中文输入成功/, 'a new shell must not replay the previous process screen')
      checks.push('Restore tabs, active tab and current directory with a clean new shell when keep-running is off')
    await manager.command('close', { id: info.id })
    await manager.command('preferences', { preferences: { restoreOnStartup: false, keepRunningOnExit: false } })
    await manager.detach(); await sleep(1200)
    manager = client(); state = await manager.synchronize()
    assert.equal(state.sessions.length, 0)
    assert.equal(state.preferences.restoreOnStartup, false)
    checks.push('Explicitly closed tabs never restore; disabling restoration opens no old terminals')
    if (!state.shells.find(item => item.kind === 'wsl').available) {
      state = await manager.command('create', { input: create('wsl') })
      assert.match(state.sessions[0].error, /WSL/); await manager.command('close', { id: state.sessions[0].id })
      checks.push('Unavailable WSL reports setup requirement without installing anything')
    } else {
      const wsl = create('wsl'); const wslState = await manager.command('create', { input: wsl }); assert.equal(wslState.sessions.find(item => item.id === wsl.id).status, 'running', wslState.sessions.find(item => item.id === wsl.id).error)
      await send(manager, wsl.id, 'printf "WSL_NATIVE_OK\\n"\r'); await output(manager, wsl.id, /WSL_NATIVE_OK/)
      await send(manager, wsl.id, 'cd /tmp; printf "WSL_DIRECTORY_READY\\n"\r')
      await until(async () => (await manager.command('state')).sessions.find(item => item.id === wsl.id)?.directory.endsWith('\\tmp'), 'WSL current directory')
      await manager.command('preferences', { preferences: { restoreOnStartup: true, keepRunningOnExit: false } }); await manager.detach(); await sleep(1200)
      manager = client(); const resumedWsl = await manager.synchronize(); assert.equal(resumedWsl.sessions.find(item => item.id === wsl.id).status, 'running', resumedWsl.sessions.find(item => item.id === wsl.id).error)
      await send(manager, wsl.id, 'printf "WSL_RESTORED:%s\\n" "$PWD"\r'); await output(manager, wsl.id, /WSL_RESTORED:\/tmp/)
      await manager.command('close', { id: wsl.id }); checks.push('Installed WSL launches a Linux shell and restores its Linux current directory')
    }
    // OpenCode now runs only in Work tabs (main-process agent); the detached host must refuse it.
    const native = create('opencode', workspace, { opencode: { workspaceId: 'qa', model: 'qa-model', accessScope: 'group' } })
    await assert.rejects(manager.command('create', { input: native }), /Work/)
    assert.equal((await manager.command('state')).sessions.some(item => item.id === native.id), false)
    checks.push('Detached host refuses OpenCode tabs; OpenCode opens in Work')
    const saved = fs.readFileSync(path.join(options.home, 'sessions.json'), 'utf8')
    assert.ok(!saved.includes('apiKeys') && !saved.includes('proxyPort') && !saved.includes('password'))
    fs.writeFileSync(path.join(scratch, 'report.json'), JSON.stringify({ passed: true, checks, wslAvailable: state.shells.find(item => item.kind === 'wsl').available }, null, 2))
    console.log('PASS: ' + checks.join('; '))
  })().catch(error => { console.error(error); fs.writeFileSync(path.join(scratch, 'failure.json'), JSON.stringify({ error: error.message, checks }, null, 2)); process.exitCode = 1 }).finally(async () => {
    clearInterval(nativePoll)
    fs.writeFileSync(path.join(scratch, 'native-output.txt'), nativeOutput)
    if (manager) {
      try { const state = await manager.command('state'); for (const session of state.sessions) await manager.command('close', { id: session.id }); await manager.command('preferences', { preferences: { restoreOnStartup: true, keepRunningOnExit: false } }); await manager.detach() }
      catch (error) { console.error('Cleanup:', error.message) }
    }
    server.closeAllConnections(); server.close(); console.log('QA artifacts: ' + scratch)
  })
}
