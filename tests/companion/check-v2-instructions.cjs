// Real V2 runtime + local deterministic provider; never calls an external model.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { spawnSync } = require('node:child_process')
const { randomBytes } = require('node:crypto')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '../..')
const scratch = path.join(root, 'tmp', 'qa', 'v2-instructions-' + Date.now())
const repository = path.join(scratch, 'repository')
const workspace = path.join(repository, 'parent', 'authorized')
const profile = path.join(scratch, 'profile')
const token = randomBytes(12).toString('hex')
const blocked = ['GIT_ROOT_AGENTS_', 'PARENT_AGENTS_', 'PARENT_CLAUDE_', 'PROJECT_CUSTOM_', 'LOCATION_AGENTS_'].map(prefix => prefix + token)
const allowed = 'INSIDE_GRANT_INSTRUCTIONS_' + token
const content = 'READ_FILE_CONTENT_' + token
fs.mkdirSync(path.join(workspace, 'docs'), { recursive: true })
fs.mkdirSync(profile, { recursive: true })
fs.writeFileSync(path.join(repository, 'AGENTS.md'), blocked[0])
fs.writeFileSync(path.join(repository, 'parent', 'AGENTS.md'), blocked[1])
fs.writeFileSync(path.join(repository, 'parent', 'CLAUDE.md'), blocked[2])
fs.writeFileSync(path.join(repository, 'parent', 'outside-instructions.md'), blocked[3])
fs.writeFileSync(path.join(repository, 'opencode.json'), JSON.stringify({ instructions: [path.join(repository, 'parent', 'outside-instructions.md')] }))
fs.writeFileSync(path.join(workspace, 'AGENTS.md'), blocked[4])
fs.writeFileSync(path.join(workspace, 'docs', 'AGENTS.md'), allowed)
fs.writeFileSync(path.join(workspace, 'docs', 'hello.txt'), content)
const git = spawnSync('git', ['-c', 'init.defaultBranch=main', 'init', '--quiet', repository], { windowsHide: true, encoding: 'utf8' })
assert.equal(git.status, 0, 'Synthetic Git repository initialization failed: ' + git.stderr)
buildSync({ entryPoints: [path.join(root, 'src/main/companion/opencode.ts')], outfile: path.join(scratch, 'service.cjs'), bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
const { OpenCodeService } = require(path.join(scratch, 'service.cjs'))
const grant = { id: 'qa', path: fs.realpathSync(workspace), name: 'Synthetic directory', writable: false }
const requests = []
let service
const server = http.createServer(async (req, res) => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  if (req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return }
  try {
    const body = JSON.parse(raw)
    requests.push(body)
    const hasResult = body.messages.some(message => message.role === 'tool')
    const canRead = body.tools?.some(tool => tool.function?.name === 'read')
    const choice = canRead && !hasResult
      ? { delta: { tool_calls: [{ index: 0, id: 'read-instruction-qa', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: path.join(workspace, 'docs', 'hello.txt') }) } }] }, finish_reason: 'tool_calls' }
      : { delta: { content: 'Synthetic instruction-boundary check completed.' }, finish_reason: 'stop' }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end('data: ' + JSON.stringify({ id: 'qa-' + requests.length, object: 'chat.completion.chunk', created: 1, model: 'qa-model', choices: [{ index: 0, ...choice }] }) + '\n\ndata: [DONE]\n\n')
  } catch (error) { res.writeHead(500).end(JSON.stringify({ error: { message: error.message } })) }
})
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const deadline = setTimeout(() => { console.error('Instruction probe deadline exceeded'); service?.dispose(); server.closeAllConnections(); server.close(); process.exit(1) }, 120000)
;(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const storage = { home: profile, get: async () => ({ settings: { persona: 'Synthetic test assistant.' }, workspaces: [grant] }), grant: async () => grant }
  const executable = process.argv[2] || path.join(root, 'companion', 'runtime', 'opencode-v2', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe')
  service = new OpenCodeService(storage, () => ({ proxyHost: '127.0.0.1', proxyPort: server.address().port, enableApiKey: false, apiKeys: [] }), executable)
  let result = await service.start({ workspaceId: grant.id, model: 'qa-model', prompt: 'Read docs/hello.txt with the read tool and finish.', newSession: true })
  const until = Date.now() + 80000
  while (result.running && Date.now() < until) {
    await delay(300)
    result = await service.poll()
    assert.equal(result.permissions.length, 0, 'This test must require no approval')
  }
  fs.writeFileSync(path.join(scratch, 'result.json'), JSON.stringify({ result, requestCount: requests.length, blocked, allowed, content, requests }, null, 2))
  assert.equal(result.running, false)
  assert.equal(result.error, '')
  assert.ok(result.tools.some(tool => tool.name === 'read' && tool.status === 'completed'))
  const messages = JSON.stringify(requests.map(request => request.messages))
  for (const marker of blocked) assert.equal(messages.includes(marker), false, 'Unauthorized/default instruction leaked: ' + marker)
  assert.ok(messages.includes(content), 'Actual read result did not reach the provider')
  assert.ok(messages.includes(allowed), 'Authorized nested instruction positive control was not loaded')
  console.log(JSON.stringify({ passed: true, requestCount: requests.length, unauthorizedInstructionsPresent: false, authorizedNestedInstructionsPresent: true, evidence: path.join(scratch, 'result.json') }))
})().catch(error => { console.error(error.message); console.error('Evidence:', scratch); process.exitCode = 1 }).finally(() => {
  clearTimeout(deadline)
  service?.dispose()
  server.closeAllConnections()
  server.close()
})
