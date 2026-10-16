// Opt-in live catalogue check and isolated native session startup. Sends no model prompts.
const { app } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..')
const scratch = fs.mkdtempSync(path.join(root, 'tmp', 'opencode-free-startup-'))
app.setPath('userData', path.join(scratch, 'profile'))
app.disableHardwareAcceleration()
buildSync({ stdin: { contents: "export { OpenCodeService } from './src/main/companion/opencode.ts'; export { OpenCodeTerminalService } from './src/main/companion/terminal.ts'; export { configureOpenCodeFreeModelCache, getOpenCodeFreeModels } from './src/main/companion/opencodeModels.ts';", resolveDir: root }, outfile: path.join(scratch, 'service.cjs'), bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
const { OpenCodeService, OpenCodeTerminalService, configureOpenCodeFreeModelCache, getOpenCodeFreeModels } = require(path.join(scratch, 'service.cjs'))
let agent, terminals
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
app.whenReady().then(async () => {
  configureOpenCodeFreeModelCache(path.join(scratch, 'models.json'))
  const catalogue = await getOpenCodeFreeModels(true)
  assert.equal(catalogue.stale, false, catalogue.error)
  assert.ok(catalogue.models.length > 0)
  const free = catalogue.models.find(model => model.toolCall && model.protocol === 'chat-completions')
  assert.ok(free)
  const home = path.join(scratch, 'companion')
  const workspace = { id: 'qa-free-workspace', path: path.join(scratch, 'workspace'), name: 'Free model startup check', writable: true }
  fs.mkdirSync(workspace.path, { recursive: true })
  const storage = { home, get: async () => ({ settings: { persona: 'Local startup verification.' }, workspaces: [workspace], groups: [] }) }
  const executable = path.join(root, 'companion', 'runtime', 'opencode-v2', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe')
  agent = new OpenCodeService(storage, () => { throw new Error('Free model must not use the proxy') }, executable)
  terminals = new OpenCodeTerminalService(agent, home)
  let result = await terminals.open({ workspaceId: workspace.id, groupId: '', accessScope: 'group', relativePath: '', model: free.id, cols: 110, rows: 30, newSession: true })
  const deadline = Date.now() + 30000
  while ((!result.data || result.starting) && Date.now() < deadline) {
    await sleep(200)
    result = terminals.poll(result.id, 0)
    if (result.error) throw new Error(result.error)
  }
  assert.equal(result.running, true)
  assert.equal(result.error, '')
  assert.ok(result.sessionId)
  assert.ok(result.data.length > 0, 'Native OpenCode rendered no output')
  // Wait for initialization failures instead of accepting only the first PTY output.
  await sleep(2500)
  result = terminals.poll(result.id, 0)
  assert.equal(result.running, true)
  assert.equal(result.error, '')
  const servers = path.join(home, 'data', 'opencode-v2', 'servers')
  const configs = fs.readdirSync(servers).map(name => JSON.parse(fs.readFileSync(path.join(servers, name, 'opencode.json'), 'utf8')))
  assert.ok(configs.length > 0)
  for (const config of configs) assert.equal(config.providers.opencode.settings.baseURL, 'https://opencode.ai/inference/openai/v1')
  fs.writeFileSync(path.join(scratch, 'terminal.txt'), result.data)
  const report = { passed: true, catalogueCount: catalogue.models.length, selectedModel: free.id, sessionId: result.sessionId, nativeTerminalRunning: result.running, inferencePromptsSent: 0, endpoint: configs[0].providers.opencode.settings.baseURL }
  await agent.dispose()
  await terminals.close()
  fs.writeFileSync(path.join(scratch, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ ...report, evidence: scratch }))
}).catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  try { await terminals?.close(); await agent?.dispose() } catch (error) { console.error(error); process.exitCode = 1 }
  app.exit(process.exitCode || 0)
})
