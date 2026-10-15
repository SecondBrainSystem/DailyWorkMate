// Real OpenCode v2 and native PTY; isolated folders and a deterministic local model.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..')
const scratch = fs.mkdtempSync(path.join(root, 'tmp', 'terminal-native-'))
const workspace = path.join(scratch, 'workspace')
fs.mkdirSync(workspace)
fs.writeFileSync(path.join(workspace, 'hello.txt'), 'NATIVE_TERMINAL_FILE_QA')
buildSync({ stdin: { contents: "export { OpenCodeService } from './src/main/companion/opencode.ts'; export { OpenCodeTerminalService } from './src/main/companion/terminal.ts';", resolveDir: root }, outfile: path.join(scratch, 'service.cjs'), bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
const { OpenCodeService, OpenCodeTerminalService } = require(path.join(scratch, 'service.cjs'))
const requests = []
let terminal, agent, output = '', modelFailed
const server = http.createServer(async (req, res) => {
  try {
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    assert.equal(req.headers.authorization, 'Bearer terminal-qa-key')
    requests.push(body)
    const messages = body.messages || []
    const done = messages.some(message => message.role === 'tool')
    const call = { name: 'read', arguments: JSON.stringify({ path: path.join(workspace, 'hello.txt') }) }
    const content = done ? 'NATIVE_TERMINAL_COMPLETE: ' + messages.filter(message => message.role === 'tool').map(message => message.content).join(' ') : ''
    res.setHeader('Content-Type', 'text/event-stream')
    const delta = done ? { content } : { tool_calls: [{ index: 0, id: 'terminal_read_qa', type: 'function', function: call }] }
    res.write('data: ' + JSON.stringify({ id: 'qa', object: 'chat.completion.chunk', created: 1, model: 'qa-model', choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n')
    res.write('data: ' + JSON.stringify({ id: 'qa', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: done ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } }) + '\n\n')
    res.end('data: [DONE]\n\n')
  } catch (error) { modelFailed = error; res.writeHead(500).end(error.message) }
})
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(check, label, ms = 45000) {
  const end = Date.now() + ms
  while (!check()) { if (Date.now() > end) throw new Error('Timed out: ' + label); await sleep(100) }
}
;(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const storage = { home: scratch, get: async () => ({ settings: { persona: 'Test companion. Reply in Chinese.' },
    workspaces: [{ id: 'qa', name: 'Terminal QA', path: workspace, writable: false }], groups: [] }) }
  agent = new OpenCodeService(storage, () => ({ proxyHost: '127.0.0.1', proxyPort: server.address().port, enableApiKey: true, apiKeys: [{ key: 'terminal-qa-key', enabled: true }] }), path.join(root, 'companion/runtime/opencode-v2/node_modules/@opencode/cli/bin/opencode.exe'))
  terminal = new OpenCodeTerminalService(agent, scratch)
  let state = await terminal.open({ workspaceId: 'qa', model: 'qa-model', cols: 110, rows: 35 })
  assert.equal(requests.length, 0, 'connecting must not submit a model prompt')
  const firstSession = state.sessionId
  const timer = setInterval(() => {
    try {
      state = terminal.poll(state.id, state.cursor)
      output += state.data
      // Reply to native terminal probes without writing user commands.
      if (state.data.includes('\x1b[6n')) terminal.write(state.id, '\x1b[1;1R')
      if (state.data.includes('\x1b[c')) terminal.write(state.id, '\x1b[?1;2c')
      if (state.data.includes('\x1b[?u')) terminal.write(state.id, '\x1b[?0u')
      if (state.data.includes('\x1b[>q')) terminal.write(state.id, '\x1bP>|xterm\x1b\\')
      if (state.data.includes('\x1b]11;?')) terminal.write(state.id, '\x1b]11;rgb:1616/1818/1d1d\x1b\\')
    } catch (error) { modelFailed ||= error }
  }, 80)
  try {
    await waitFor(() => /DailyWorkMate|Terminal QA|qa-model/.test(output) || !state.running, 'native TUI initial render')
    assert.ok(state.running, state.error || output.slice(-2000))
    await sleep(800)
    terminal.write(state.id, '\x1b[200~请读取 hello.txt 并返回实际内容 NATIVE_INPUT_QA\x1b[201~')
    await sleep(400)
    terminal.write(state.id, '\r')
    await waitFor(() => output.includes('NATIVE_TERMINAL_COMPLETE') || !state.running, 'native TUI model reply')
    assert.ok(!modelFailed, modelFailed?.message)
    assert.ok(requests.some(request => JSON.stringify(request.messages).includes('NATIVE_INPUT_QA')))
    assert.ok(requests.some(request => JSON.stringify(request.messages).includes('NATIVE_TERMINAL_FILE_QA')))
    terminal.resize(state.id, 85, 25)
    await terminal.close(state.id)
    const resumed = await terminal.open({ workspaceId: 'qa', model: 'qa-model', cols: 100, rows: 30, sessionId: firstSession })
    assert.equal(resumed.sessionId, firstSession)
    await terminal.close(resumed.id)
    fs.writeFileSync(path.join(scratch, 'report.json'), JSON.stringify({ passed: true, sessionId: firstSession, requests: requests.length, checks: ['native TUI', 'authenticated server', 'Unicode keyboard input', 'guarded file read', 'resize', 'close', 'native session resume'] }, null, 2))
    console.log('PASS: real OpenCode v2 TUI, Unicode terminal input, authenticated model, guarded file read, resize, close and native session resume')
  } finally { clearInterval(timer) }
})().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  fs.writeFileSync(path.join(scratch, 'terminal-output.txt'), output)
  await terminal?.close()
  await agent?.dispose()
  server.closeAllConnections(); server.close()
  console.log('QA artifacts: ' + scratch)
})
