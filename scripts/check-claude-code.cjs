// Real Claude Code CLI + local mock Anthropic API: chat turns, tool use, resume, read-only limits and Work TUI.
// Uses an isolated data folder; no request leaves this computer.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..')
fs.mkdirSync(path.join(root, 'tmp'), { recursive: true })
const scratch = fs.mkdtempSync(path.join(root, 'tmp', 'claude-code-'))
const workspace = path.join(scratch, 'workspace')
fs.mkdirSync(workspace)
const secret = 'CLAUDE_QA_' + Math.random().toString(36).slice(2, 10).toUpperCase()
fs.writeFileSync(path.join(workspace, 'tasks.json'), JSON.stringify({ latest: secret }))
buildSync({ stdin: { contents: "export * from './src/main/companion/claudeCode.ts'; export { terminalSpawner } from './src/main/companion/terminalProcess.ts';", resolveDir: root }, outfile: path.join(scratch, 'claude.cjs'), bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
const { ClaudeCodeAgent, ClaudeCodeTerminalService, findClaudeCode, terminalSpawner } = require(path.join(scratch, 'claude.cjs'))

const requests = []
const sse = (res, events) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const event of events) res.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n')
  res.end()
}
const message = (blocks, stop) => [
  { type: 'message_start', message: { id: 'msg_' + requests.length, type: 'message', role: 'assistant', model: 'qa-model', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } },
  ...blocks.flatMap((block, index) => block.type === 'text'
    ? [{ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } }, { type: 'content_block_stop', index }]
    : [{ type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } }, { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } }, { type: 'content_block_stop', index }]),
  { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } },
  { type: 'message_stop' },
]
const server = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk
  if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) { res.writeHead(404).end('{}'); return }
  if (req.url.startsWith('/v1/messages/count_tokens')) { res.end(JSON.stringify({ input_tokens: 10 })); return }
  const body = JSON.parse(raw)
  requests.push({ headers: req.headers, body })
  const flat = JSON.stringify(body.messages)
  const tools = (body.tools || []).map(tool => tool.name)
  const results = body.messages.flatMap(item => Array.isArray(item.content) ? item.content.filter(part => part.type === 'tool_result') : [])
  if (!tools.length || !flat.includes('CLAUDE_TASK')) return sse(res, message([{ type: 'text', text: 'OK' }], 'end_turn'))
  if (flat.includes('WRITE_TASK') && !results.length) return sse(res, message([{ type: 'tool_use', id: 'toolu_write', name: tools.includes('Write') ? 'Write' : 'Edit', input: { file_path: path.join(workspace, 'new.txt'), content: 'x' } }], 'tool_use'))
  if (flat.includes('WRITE_TASK')) return sse(res, message([{ type: 'text', text: 'WRITE_DONE tools=' + tools.join(',') + ' results=' + JSON.stringify(results.map(item => item.content)).slice(0, 400) }], 'end_turn'))
  if (!results.length) return sse(res, message([{ type: 'text', text: 'Reading.' }, { type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: path.join(workspace, 'tasks.json') } }], 'tool_use'))
  return sse(res, message([{ type: 'text', text: 'ANSWER ' + (JSON.stringify(results).includes(secret) ? secret : 'MISSING') + ' turns=' + body.messages.filter(item => item.role === 'user' && JSON.stringify(item.content).includes('CLAUDE_TASK')).length }], 'end_turn'))
})
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function run(agent, input) {
  let state = await agent.start(input)
  const end = Date.now() + 120000
  while (state.running) { if (Date.now() > end) throw new Error('Timed out: ' + JSON.stringify(state)); await sleep(200); state = await agent.poll() }
  return state
}
;(async () => {
  const launch = findClaudeCode()
  if (!launch) { console.log('SKIP: Claude Code is not installed'); return }
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let grants = [{ id: 'qa', name: 'QA', path: workspace, writable: false }]
  const storage = { home: scratch, get: async () => ({ workspaces: grants, groups: [] }) }
  const proxy = () => ({ proxyHost: '127.0.0.1', proxyPort: server.address().port, enableApiKey: true, apiKeys: [{ key: 'claude-qa-key', enabled: true }] })
  const agent = new ClaudeCodeAgent(storage, proxy)
  const first = await run(agent, { workspaceId: 'qa', model: 'qa-model', prompt: 'CLAUDE_TASK read tasks.json', systemPrompt: 'QA persona' })
  assert.equal(first.error, '', first.error)
  assert.match(first.text, new RegExp('ANSWER ' + secret))
  assert.ok(first.tools.some(tool => tool.name === 'Read' && tool.status === 'completed'), JSON.stringify(first.tools))
  assert.match(first.sessionId, /^cc:[0-9a-f]{16}:[0-9a-f-]{36}$/)
  const sent = requests.find(item => item.body.tools?.length)
  assert.equal(sent.headers.authorization, 'Bearer claude-qa-key')
  assert.equal(sent.body.model, 'qa-model')
  assert.ok(requests.every(item => item.body.model === 'qa-model'), 'every Claude Code request uses the chosen model: ' + [...new Set(requests.map(item => item.body.model))])
  assert.match(JSON.stringify(sent.body.system), /QA persona/)
  assert.ok(!sent.body.tools.some(tool => ['Write', 'Edit', 'Bash', 'PowerShell'].includes(tool.name)), 'read-only scope removes write and command tools: ' + sent.body.tools.map(tool => tool.name))
  console.log('PASS: chat turn read a workspace file through Claude Code; tools offered: ' + sent.body.tools.map(tool => tool.name).join(','))

  const second = await run(agent, { workspaceId: 'qa', model: 'qa-model', prompt: 'CLAUDE_TASK again', sessionId: first.sessionId })
  assert.equal(second.sessionId, first.sessionId)
  assert.match(second.text, /turns=2/, 'the second turn resumes the first: ' + second.text)
  console.log('PASS: second turn resumed the same Claude Code session')

  grants = [{ id: 'qa', name: 'QA', path: workspace, writable: true }]
  const write = await run(agent, { workspaceId: 'qa', model: 'qa-model', prompt: 'CLAUDE_TASK WRITE_TASK create new.txt', newSession: true })
  assert.equal(write.error, '', write.error)
  assert.ok(fs.existsSync(path.join(workspace, 'new.txt')), 'writable chat accepts edits: ' + write.text)
  assert.match(write.text, /Bash|PowerShell/, 'writable chat offers commands')
  console.log('PASS: writable workspace accepted an edit in chat')

  // Work tab: interactive Claude Code in a pseudo terminal.
  const terminals = new ClaudeCodeTerminalService(storage, proxy, () => terminalSpawner(path.join(root, 'scripts', 'companion-pty-host.cjs'), 'node-pty'))
  let output = ''
  let state = await terminals.open({ workspaceId: 'qa', model: 'qa-model', cols: 120, rows: 36, terminalId: '0123456789abcdef0123456789abcdef' })
  const screen = () => output.replace(/\x1b\[[0-9;?<>=]*[a-zA-Z]|\x1b\][^\x07]*\x07/g, '')
  const end = Date.now() + 60000
  while (state.running && !/trust|Welcome|Try "|for shortcuts/i.test(screen()) && Date.now() < end) { await sleep(200); state = terminals.poll(state.id, state.cursor); output += state.data }
  assert.ok(state.running, 'Claude Code TUI starts: ' + state.error + output.slice(-500))
  assert.doesNotMatch(screen(), /Select login method|Log in with/i, 'no Anthropic login is requested')
  assert.match(state.sessionId, /^cc:/)
  await terminals.close()
  fs.writeFileSync(path.join(scratch, 'tui.txt'), output)
  console.log('PASS: Claude Code TUI started in a pseudo terminal')
  fs.writeFileSync(path.join(scratch, 'report.json'), JSON.stringify({ passed: true, launch: launch.display, requests: requests.length }, null, 2))
})().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => { server.close(); console.log('QA artifacts: ' + scratch) })
