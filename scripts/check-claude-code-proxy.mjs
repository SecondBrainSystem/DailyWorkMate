// Real Claude Code CLI -> DailyWorkMate /v1/messages (real conversion and dispatch) -> mock Ollama node.
// Covers the chat (-p) path and the interactive Work TUI. Isolated store and data; nothing leaves this computer.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import Koa from 'koa'
import bodyParser from 'koa-bodyparser'

const root = path.resolve(import.meta.dirname, '..')
mkdirSync(path.join(root, 'tmp'), { recursive: true })
const scratch = mkdtempSync(path.join(root, 'tmp', 'claude-proxy-'))
const workspace = path.join(scratch, 'workspace')
mkdirSync(workspace)
const secret = 'PROXY_QA_' + Math.random().toString(36).slice(2, 10).toUpperCase()
writeFileSync(path.join(workspace, 'tasks.json'), JSON.stringify({ latest: secret }))
const output = path.join(scratch, 'proxy.mjs')
await build({
  stdin: { contents: `export { default as claude } from './src/main/proxy/routes/claude.ts'; export { setup, state } from './src/main/store/store'; export * from './src/main/companion/claudeCode.ts'; export { terminalSpawner } from './src/main/companion/terminalProcess.ts'`, resolveDir: root },
  outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external',
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  plugins: [{ name: 'isolate-store', setup(builder) {
    builder.onResolve({ filter: /(?:^electron$|\/store\/store(?:\.ts)?$)/ }, args => ({ path: args.path === 'electron' ? 'electron' : 'store', namespace: 'qa' }))
    builder.onLoad({ filter: /.*/, namespace: 'qa' }, args => ({ contents: args.path === 'electron'
      ? 'export const app = { isPackaged:false }; export const net = {}; export const shell = {}; export class BrowserWindow {}'
      : `import { DEFAULT_CONFIG } from './src/main/store/types.ts';
        export const state = { logs: [], requests: [], account: {id: 'account', providerId: 'node', name: 'QA', status: 'active', credentials: {authType:'none'}} };
        export const setup = endpoint => { state.provider = {id:'node', name:'QA', enabled:true, type:'custom', upstreamKind:'ollama', apiEndpoint:endpoint, headers:{}, supportedModels:['model'], ollamaModels:{model:{name:'model',endpoint:'ollama_chat',vision:'unknown'}}} };
        export const storeManager = {
          getConfig: () => ({...DEFAULT_CONFIG,retryCount:0}), getSessionConfig: () => DEFAULT_CONFIG.sessionConfig,
          getProviders: () => [state.provider], getEffectiveModels: () => [{displayName:'model',actualModelId:'model'}],
          getAccountsByProviderId: () => [state.account], getAccountById: () => state.account,
          updateAccount: (_id, updates) => {state.account = {...state.account,...updates}},
          addLog: (...args) => state.logs.push(args), recordRequestInStats: () => {}, recordTokenUsage: () => {},
          addRequestLog: log => {const entry = {...log,id:String(state.requests.length)};state.requests.push(entry);return entry},
          updateRequestLog: () => {},
        }`, resolveDir: root }))
  } }],
})
const mod = await import(pathToFileURL(output))
const upstreamBodies = []
const upstream = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk
  const body = JSON.parse(raw)
  upstreamBodies.push(body)
  const flat = JSON.stringify(body.messages)
  const toolMessages = body.messages.filter(message => message.role === 'tool')
  const tools = (body.tools || []).map(tool => tool.function?.name)
  let message
  if (!tools.length || !flat.includes('CLAUDE_TASK')) message = { role: 'assistant', content: 'OK' }
  else if (!toolMessages.length) message = { role: 'assistant', content: '', tool_calls: [{ function: { name: 'Read', arguments: { file_path: path.join(workspace, 'tasks.json') } } }] }
  else message = { role: 'assistant', content: 'ANSWER ' + (JSON.stringify(toolMessages).includes(secret) ? secret : 'MISSING') }
  if (!body.stream) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ model: body.model, message, done: true, done_reason: 'stop', prompt_eval_count: 5, eval_count: 3 })); return }
  res.setHeader('Content-Type', 'application/x-ndjson')
  res.write(JSON.stringify({ model: body.model, message, done: false }) + '\n')
  res.end(JSON.stringify({ model: body.model, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 5, eval_count: 3 }) + '\n')
})
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
mod.setup(`http://127.0.0.1:${upstream.address().port}/`)
const app = new Koa()
const errors = []
app.use(async (ctx, next) => { await next(); if (ctx.status >= 400) errors.push(ctx.status + ' ' + JSON.stringify(ctx.body)) })
app.use(bodyParser({ jsonLimit: '50mb' }))
app.use(mod.claude.routes())
const proxy = createServer(app.callback())
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
try {
  if (!mod.findClaudeCode()) { console.log('SKIP: Claude Code is not installed'); process.exit(0) }
  const storage = { home: scratch, get: async () => ({ workspaces: [{ id: 'qa', name: 'QA', path: workspace, writable: false }], groups: [] }) }
  const proxyConfig = () => ({ proxyHost: '127.0.0.1', proxyPort: proxy.address().port, enableApiKey: false, apiKeys: [] })
  const agent = new mod.ClaudeCodeAgent(storage, proxyConfig)
  let state = await agent.start({ workspaceId: 'qa', model: 'model', prompt: 'CLAUDE_TASK read tasks.json', systemPrompt: 'QA persona', history: [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'reply' }] })
  const end = Date.now() + 120000
  while (state.running && Date.now() < end) { await sleep(200); state = await agent.poll() }
  assert.equal(errors.length, 0, 'proxy errors: ' + errors.join('\n'))
  assert.equal(state.error, '', state.error)
  assert.match(state.text, new RegExp('ANSWER ' + secret), state.text)
  assert.ok(state.tools.some(tool => tool.name === 'Read' && tool.status === 'completed'), JSON.stringify(state.tools))
  for (const body of upstreamBodies) {
    const roles = body.messages.map(message => message.role)
    assert.ok(roles.indexOf('system') <= 0 && roles.lastIndexOf('system') <= 0, 'only one leading system message reaches the upstream: ' + roles)
    assert.equal(body.think, undefined, 'adaptive thinking is not forced on the model')
  }
  console.log('PASS: chat through DailyWorkMate /v1/messages read a workspace file with Claude Code (' + upstreamBodies.length + ' upstream requests)')

  // Work tab: trust the folder, submit a task, see the answer on screen.
  const terminals = new mod.ClaudeCodeTerminalService(storage, proxyConfig, () => mod.terminalSpawner(path.join(root, 'scripts', 'companion-pty-host.cjs'), 'node-pty'))
  let tui = await terminals.open({ workspaceId: 'qa', model: 'model', cols: 120, rows: 36, terminalId: 'abcdefabcdefabcdefabcdefabcdef12' })
  let screen = ''
  const plain = () => screen.replace(/\x1b\[[0-9;?<>=]*[a-zA-Z]|\x1b\][^\x07]*\x07/g, ' ')
  const read = () => { tui = terminals.poll(tui.id, tui.cursor); screen += tui.data }
  const waitFor = async (pattern, label, ms = 60000) => { const stop = Date.now() + ms; while (!pattern.test(plain())) { if (!tui.running || Date.now() > stop) throw new Error('Timed out: ' + label + '\n' + plain().slice(-1500)); await sleep(200); read() } }
  // The folder is authorized in DailyWorkMate, so Claude Code opens without its "No, exit" trust prompt.
  await waitFor(/for shortcuts|Try "|\? for|❯/i, 'Claude Code prompt')
  assert.doesNotMatch(plain(), /trust this folder/i, 'authorized folders are already trusted')
  await sleep(1500); read()
  const before = upstreamBodies.length
  terminals.write(tui.id, '\x1b[200~CLAUDE_TASK read tasks.json in the work tab\x1b[201~'); await sleep(400); terminals.write(tui.id, '\r')
  await waitFor(new RegExp('ANSWER ' + secret), 'TUI answer', 90000)
  assert.ok(upstreamBodies.length > before)
  assert.equal(errors.length, 0, 'proxy errors: ' + errors.join('\n'))
  await terminals.close()
  console.log('PASS: Work tab TUI trusted the folder, ran Read through DailyWorkMate and showed the answer')
  writeFileSync(path.join(scratch, 'report.json'), JSON.stringify({ passed: true, upstreamRequests: upstreamBodies.length }, null, 2))
} catch (error) {
  console.error(error); process.exitCode = 1
} finally {
  writeFileSync(path.join(scratch, 'upstream.json'), JSON.stringify(upstreamBodies.map(body => ({ ...body, tools: (body.tools || []).map(tool => tool.function?.name) })), null, 2))
  proxy.closeAllConnections(); proxy.close(); upstream.closeAllConnections(); upstream.close()
  console.log('QA artifacts: ' + scratch)
}
