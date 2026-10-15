// Opt-in live check: actual OpenCode + official free provider, synthetic read-only workspace.
// Run: node scripts/check-opencode-free.cjs --model opencode-free/<current-free-model>
// --writable only changes the freshly created synthetic grant; shell approvals are still rejected.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
const args = process.argv.slice(2)
const modelIndex = args.indexOf('--model')
const model = modelIndex >= 0 ? args[modelIndex + 1] : ''
const writable = args.includes('--writable')
const runtimeIndex = args.indexOf('--runtime')
const runtime = runtimeIndex >= 0 && args[runtimeIndex + 1] ? path.resolve(args[runtimeIndex + 1]) : undefined
if (runtimeIndex >= 0 && (!runtime || !fs.existsSync(runtime) || !fs.statSync(runtime).isFile())) {
  console.error('--runtime must point to an existing OpenCode executable')
  process.exit(2)
}
if (!model?.startsWith('opencode-free/') || model.length <= 'opencode-free/'.length) {
  console.error('Choose a current free model: node scripts/check-opencode-free.cjs --model opencode-free/<id>')
  process.exit(2)
}

const scratch = path.join(root, 'tmp', 'opencode-free-' + process.pid + '-' + Date.now())
const workspace = path.join(scratch, 'workspace')
const marker = 'OPENCODE_NATIVE_READ_' + crypto.randomBytes(8).toString('hex')
const expectedNames = ['manifest.txt', 'notes.txt', 'samples']
fs.mkdirSync(path.join(workspace, 'samples'), { recursive: true })
fs.writeFileSync(path.join(workspace, 'manifest.txt'), marker + '\n')
fs.writeFileSync(path.join(workspace, 'notes.txt'), 'This directory contains only synthetic integration-test data.\n')
fs.writeFileSync(path.join(workspace, 'samples', 'sample.csv'), 'sample,value\nalpha,1\n')
const executable = runtime || path.join(root, 'companion', 'runtime', 'opencode-v2', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe')
buildSync({
  entryPoints: [path.join(root, 'src/main/companion/opencode.ts')],
  outfile: path.join(scratch, 'service.cjs'), bundle: true, platform: 'node', format: 'cjs', packages: 'external',
})
const { OpenCodeService } = require(path.join(scratch, 'service.cjs'))
const grant = { id: 'live-free-qa', path: fs.realpathSync(workspace), name: 'Synthetic QA', writable }
const proxyRequests = []
const proxy = http.createServer(async (req, res) => {
  proxyRequests.push({ method: req.method, path: req.url })
  req.resume()
  res.writeHead(502, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: { message: 'Free model unexpectedly used the local model proxy' } }))
})
let service
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

;(async () => {
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  const storage = {
    home: scratch,
    get: async () => ({ settings: { persona: 'You are a precise file assistant. Confirm facts only using actual tool results.' }, workspaces: [grant] }),
    grant: async id => { assert.equal(id, grant.id); return grant },
  }
  service = new OpenCodeService(storage, () => ({
    proxyHost: '127.0.0.1', proxyPort: proxy.address().port, enableApiKey: false, apiKeys: [],
  }), executable)
  assert.ok(service.available(), 'Install the bundled runtime with npm run companion:setup first')
  let snapshot = await service.start({
    workspaceId: grant.id, model, newSession: true,
    prompt: 'List the actual files and folders in the current workspace, then read manifest.txt and quote its entire first line exactly. Use your read/glob/list tools to verify both. This is a read-only task. Do not run shell commands, do not modify any file, and do not ask for write permission.',
  })
  const deadline = Date.now() + 240000
  let lastReport = 0
  while (snapshot.running && Date.now() < deadline) {
    await sleep(500)
    snapshot = await service.poll()
    if (snapshot.permissions.length) {
      for (const permission of snapshot.permissions) await service.reply(permission.id, false)
      throw new Error('Unexpected permission request: ' + snapshot.permissions.map(permission => permission.permission).join(', '))
    }
    if (Date.now() - lastReport >= 15000) {
      console.log('Waiting for official free model:', model, 'tools:', snapshot.tools.map(tool => tool.name + ':' + tool.status).join(', ') || 'none')
      lastReport = Date.now()
    }
  }
  if (snapshot.running) await service.stop()
  fs.writeFileSync(path.join(scratch, 'result.json'), JSON.stringify({ model, grant, snapshot, proxyRequests }, null, 2))
  assert.equal(snapshot.running, false, 'The live free model did not finish within four minutes')
  assert.equal(snapshot.error, '', snapshot.error)
  assert.equal(proxyRequests.length, 0, 'Native free requests must never fall back to the configured Ollama proxy')
  assert.ok(snapshot.tools.some(tool => tool.name === 'read' && tool.status === 'completed'), 'No confirmed native OpenCode file-read tool result')
  assert.ok(snapshot.text.includes(marker), 'Response did not include the randomly generated file contents')
  for (const name of expectedNames) assert.ok(snapshot.text.includes(name), 'Response did not list ' + name)
  assert.equal(fs.readFileSync(path.join(workspace, 'manifest.txt'), 'utf8'), marker + '\n')
  assert.equal(fs.readFileSync(path.join(workspace, 'notes.txt'), 'utf8'), 'This directory contains only synthetic integration-test data.\n')
  assert.equal(fs.readFileSync(path.join(workspace, 'samples', 'sample.csv'), 'utf8'), 'sample,value\nalpha,1\n')
  assert.ok(!snapshot.tools.some(tool => ['write', 'edit', 'bash', 'apply_patch'].includes(tool.name) && tool.status === 'completed'), 'Read-only task unexpectedly performed a write or shell command')
  console.log('PASS: real OpenCode, native official free model, confirmed file listing and random file-content read, no local proxy fallback, files preserved; synthetic grant writable=' + writable)
  console.log('Evidence:', path.join(scratch, 'result.json'))
})().catch(error => {
  fs.writeFileSync(path.join(scratch, 'failure.json'), JSON.stringify({ model, error: error.message, proxyRequests }, null, 2))
  console.error(error.message)
  console.error('QA output:', scratch)
  process.exitCode = 1
}).finally(() => {
  service?.dispose()
  proxy.closeAllConnections()
  proxy.close()
})
