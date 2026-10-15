// Actual project-local OpenCode V2 and a loopback-only deterministic model.
// The model learns task contents only from the real runtime's read-tool response.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { randomBytes } = require('node:crypto')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
fs.mkdirSync(path.join(root, 'tmp'), { recursive: true })
const scratch = fs.mkdtempSync(path.join(root, 'tmp', 'companion-chat-runtime-'))
const workspace = path.join(scratch, 'dailytodo')
fs.mkdirSync(workspace)
const marker = randomBytes(12).toString('hex')
const tasks = [
  { title: 'Older pending ' + marker, completed: false, createdAt: '2026-10-11T09:00:00Z' },
  { title: 'Latest pending ' + marker, completed: false, createdAt: '2026-10-12T09:00:00Z' },
  { title: 'Newest completed ' + marker, completed: true, createdAt: '2026-10-13T09:00:00Z' },
]
const expected = tasks[1].title
fs.writeFileSync(path.join(workspace, 'tasks.json'), 'TODO_RECORDS:' + JSON.stringify(tasks))
const shellOutput = path.join(scratch, 'shell-must-not-run.txt')
const executable = path.join(root, 'companion', 'runtime', 'opencode-v2', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe')
assert.ok(fs.existsSync(executable), 'Install the project-local OpenCode V2 runtime first')
buildSync({ entryPoints: [path.join(root, 'src/main/companion/opencode.ts')], outfile: path.join(scratch, 'service.cjs'), bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
const { OpenCodeService } = require(path.join(scratch, 'service.cjs'))
const grant = { id: 'dailytodo-qa', name: 'DailyTodo QA', path: fs.realpathSync(workspace), writable: true }
let service
let requests = []
let runs = []
let serverErrors = []
const server = http.createServer(async (req, res) => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  if (req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return }
  try {
    assert.equal(req.headers.authorization, 'Bearer qa-chat-key')
    assert.equal(req.headers['x-dailyworkmate-model-selection'], 'explicit')
    const body = JSON.parse(raw)
    assert.equal(body.model, 'qa-chat-model')
    requests = [...requests, body]
    const user = JSON.stringify([...body.messages].reverse().find(message => message.role === 'user')?.content || '')
    const toolMessages = body.messages.filter(message => message.role === 'tool')
    const toolText = JSON.stringify(toolMessages)
    let call
    let content = '普通聊天成功。'
    if (user.includes('CHAT_RESUME_QA')) {
      assert.ok(JSON.stringify(body.messages).includes('CHAT_PLAIN_QA'), 'Native session must retain the previous conversation')
      content = '已保留上一轮聊天。'
    }
    if (user.includes('CHAT_DENY_READ_QA')) {
      if (!toolMessages.length) call = { name: 'read', arguments: JSON.stringify({ path: path.join(workspace, 'tasks.json') }) }
      else {
        assert.ok(!toolText.includes(marker), 'Unselected saved grants must not leak file contents')
        assert.match(toolText, /denied|outside|authorized|permission|not allowed/i)
        content = '请先选择 DailyTodo 工作区。'
      }
    }
    if (user.includes('CHAT_DENY_SHELL_QA')) {
      if (!toolMessages.length) call = { name: 'shell', arguments: JSON.stringify({ command: 'echo MUST_NOT_RUN > "' + shellOutput + '"', description: 'Attempt a command in ordinary chat' }) }
      else { assert.ok(!fs.existsSync(shellOutput)); content = '普通聊天不能执行命令。' }
    }
    if (user.includes('CHAT_TODO_QA')) {
      if (!toolMessages.length) {
        assert.ok(!JSON.stringify(body.messages).includes(marker), 'The model must not know random task titles before reading the file')
        assert.ok(body.tools?.some(tool => tool.function?.name === 'read'), 'Workspace chat must expose read')
        call = { name: 'read', arguments: JSON.stringify({ path: path.join(workspace, 'tasks.json') }) }
      } else {
        const contents = toolMessages.map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n')
        const records = contents.match(/TODO_RECORDS:(\[.*\])/)
        assert.ok(records, 'Second model request must contain actual file contents returned by read')
        const pending = JSON.parse(records[1]).filter(task => !task.completed).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        assert.ok(pending.length)
        content = '最新未完成任务：' + pending[0].title
      }
    }
    const choice = call
      ? { delta: { tool_calls: [{ index: 0, id: 'call_chat_' + requests.length, type: 'function', function: call }] }, finish_reason: 'tool_calls' }
      : { delta: { content }, finish_reason: 'stop' }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    if (user.includes('CHAT_STREAM_QA')) {
      res.write('data: ' + JSON.stringify({ id: 'qa-live', object: 'chat.completion.chunk', created: 1, model: 'qa-chat-model',
        choices: [{ index: 0, delta: { content: 'STREAM_FIRST ' }, finish_reason: null }] }) + '\n\n')
      await sleep(1500)
    }
    res.write('data: ' + JSON.stringify({ id: 'qa-chat-' + requests.length, object: 'chat.completion.chunk', created: 1, model: 'qa-chat-model', choices: [{ index: 0, ...choice }] }) + '\n\n')
    res.end('data: [DONE]\n\n')
  } catch (error) {
    serverErrors = [...serverErrors, error.message]
    console.error('Model fixture:', error.message)
    res.writeHead(500).end(JSON.stringify({ error: { message: error.message } }))
  }
})
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function run(name, input) {
  const before = requests.length
  const started = Date.now()
  let status = await service.start({ workspaceId: '', model: 'qa-chat-model', newSession: true, ...input })
  let firstTextMs, livePartial = false
  for (let index = 0; index < 180 && status.running; index++) {
    await sleep(500)
    status = await service.poll()
    if (status.text && firstTextMs === undefined) firstTextMs = Date.now() - started
    if (status.running && status.text.includes('STREAM_FIRST') && !status.text.includes('普通聊天成功。')) livePartial = true
    assert.deepEqual(status.permissions, [], 'Chat must not wait on unrelated permission dialogs')
  }
  assert.equal(status.running, false, name + ' timed out: ' + JSON.stringify(status))
  assert.equal(status.error, '', name + ': ' + status.error)
  assert.deepEqual(serverErrors, [])
  runs = [...runs, { name, elapsedMs: Date.now() - started, firstTextMs, livePartial, modelRequests: requests.length - before, status }]
  return status
}

;(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const storage = { home: scratch, get: async () => ({ settings: { persona: '请根据实际工具结果用中文回答。' }, workspaces: [grant], groups: [] }) }
  service = new OpenCodeService(storage, () => ({ proxyHost: '127.0.0.1', proxyPort: server.address().port, enableApiKey: true, apiKeys: [{ key: 'qa-chat-key', enabled: true }] }), executable)
  const plain = await run('plain chat without a workspace', { prompt: 'CHAT_PLAIN_QA: 你好。' })
  assert.equal(plain.text, '普通聊天成功。')
  assert.deepEqual(plain.tools, [])
  console.log('PASS: actual OpenCode V2 ordinary chat without a selected workspace')
  const resumed = await run('ordinary chat session continuation', { prompt: 'CHAT_RESUME_QA: 继续。', sessionId: plain.sessionId, newSession: false })
  assert.equal(resumed.sessionId, plain.sessionId)
  assert.match(resumed.text, /已保留上一轮聊天/)
  console.log('PASS: native ordinary-chat history persists across turns')
  const streamed = await run('live text reaches the UI before the model finishes', { prompt: 'CHAT_STREAM_QA: 分段回复。' })
  assert.equal(streamed.text, 'STREAM_FIRST 普通聊天成功。')
  assert.equal(runs.at(-1).livePartial, true, 'A running task must expose text deltas before the durable final message')
  assert.ok(runs.at(-1).firstTextMs < runs.at(-1).elapsedMs - 500, 'The first text must arrive well before generation completes')
  console.log('PASS: actual V2 text deltas appear before the final message projection')
  const denied = await run('ordinary chat cannot read saved grants', { prompt: 'CHAT_DENY_READ_QA: 查看未选择工作区的文件。' })
  assert.ok(denied.tools.some(tool => tool.name === 'read' && tool.status === 'error'))
  assert.ok(!JSON.stringify(requests).includes(marker))
  console.log('PASS: unselected saved workspaces remain inaccessible')
  const noShell = await run('ordinary chat cannot execute commands', { prompt: 'CHAT_DENY_SHELL_QA: 尝试执行命令。' })
  assert.ok(noShell.tools.some(tool => tool.name === 'shell' && tool.status === 'error'))
  assert.ok(!fs.existsSync(shellOutput))
  console.log('PASS: actual runtime blocks shell in ordinary chat')
  await assert.rejects(service.start({ workspaceId: grant.id, model: 'qa-chat-model', prompt: 'Continue across workspace boundaries', sessionId: plain.sessionId }), /workspace|folder scope/)
  const todo = await run('workspace tools return latest incomplete task', { workspaceId: grant.id, prompt: 'CHAT_TODO_QA: dailytodo 最新未完成的任务是什么？请读取 tasks.json。' })
  assert.equal(todo.text, '最新未完成任务：' + expected)
  assert.ok(todo.tools.some(tool => tool.name === 'read' && tool.status === 'completed'))
  assert.equal(runs.at(-1).modelRequests, 2, 'One tool request, one answer grounded in the read result')
  console.log('PASS: real read tool returns random tasks; second model turn identifies latest incomplete task')
  console.log('Evidence:', path.join(scratch, 'results.json'))
})().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  fs.writeFileSync(path.join(scratch, 'results.json'), JSON.stringify({ runs, serverErrors, requests }, null, 2))
  await service?.dispose()
  server.closeAllConnections()
  server.close()
})
