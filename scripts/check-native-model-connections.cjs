// Real bundled OpenCode + deterministic local upstream; never calls an external model.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
const scratch = path.join(root, 'tmp', 'qa', 'native-model-connections-' + Date.now())
fs.mkdirSync(scratch, { recursive: true })
buildSync({ entryPoints: [path.join(root, 'src/main/companion/opencode.ts')], outfile: path.join(scratch, 'service.cjs'), bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
const { OpenCodeService } = require(path.join(scratch, 'service.cjs'))
const executable = process.argv[2] || path.join(root, 'companion', 'runtime', 'opencode-v2', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe')
const requests = []
const results = []
const services = []
const answer = 'Native model connection verified.'
const server = http.createServer(async (req, res) => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  const pathname = new URL(req.url, 'http://localhost').pathname
  if (!['/v1/chat/completions', '/v1/messages'].includes(pathname)) { res.writeHead(404).end(); return }
  try {
    const body = JSON.parse(raw)
    requests.push({ path: pathname, headers: req.headers, body })
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    if (pathname === '/v1/chat/completions') {
      res.end('data: ' + JSON.stringify({ id: 'qa-native', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { content: answer }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n')
    } else {
      const events = [
        { type: 'message_start', message: { id: 'msg_native', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answer } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
        { type: 'message_stop' },
      ]
      res.end(events.map(event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n').join(''))
    }
  } catch (error) { res.writeHead(500).end(JSON.stringify({ error: { message: error.message } })) }
})
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const deadline = setTimeout(() => { console.error('Native model check deadline exceeded'); services.forEach(service => service.dispose()); server.closeAllConnections(); server.close(); process.exit(1) }, 150000)
;(async () => {
  assert.ok(fs.existsSync(executable), 'Bundled OpenCode executable is unavailable')
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  for (const protocol of ['openai', 'anthropic']) {
    const profile = path.join(scratch, protocol)
    const connection = { baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', apiKey: 'synthetic-' + protocol + '-key', model: 'actual-' + protocol + '-model', protocol, direct: true, headers: { 'X-Project': 'synthetic-' + protocol + '-project' } }
    const storage = { home: profile, get: async () => ({ settings: { persona: 'Synthetic test assistant.' }, workspaces: [], groups: [] }) }
    const service = new OpenCodeService(storage, () => { throw new Error('External API listener must not be used') }, executable, async model => {
      assert.equal(model, 'display-alias')
      return connection
    })
    services.push(service)
    let result = await service.start({ workspaceId: '', model: 'display-alias', prompt: 'Reply with the verification text.', newSession: true })
    const until = Date.now() + 60000
    while (result.running && Date.now() < until) { await delay(200); result = await service.poll() }
    results.push({ protocol, result })
    assert.equal(result.running, false)
    assert.equal(result.error, '')
    assert.equal(result.text, answer)
    const observed = requests.filter(request => request.body.model === connection.model)
    assert.ok(observed.length > 0, 'Actual upstream model name was not sent')
    for (const request of observed) {
      assert.equal(request.path, protocol === 'anthropic' ? '/v1/messages' : '/v1/chat/completions')
      assert.equal(request.headers[protocol === 'anthropic' ? 'x-api-key' : 'authorization'], protocol === 'anthropic' ? connection.apiKey : 'Bearer ' + connection.apiKey)
      assert.equal(request.headers['x-project'], connection.headers['X-Project'])
      assert.equal(request.headers['x-dailyworkmate-model-selection'], undefined)
    }
    const configs = fs.readdirSync(path.join(profile, 'data', 'opencode-v2', 'servers'), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => fs.readFileSync(path.join(profile, 'data', 'opencode-v2', 'servers', entry.name, 'opencode.json'), 'utf8'))
    for (const config of configs) {
      assert.equal(config.includes(connection.apiKey), false)
      assert.equal(config.includes(connection.headers['X-Project']), false)
    }
    service.dispose()
  }
  fs.writeFileSync(path.join(scratch, 'report.json'), JSON.stringify({ passed: true, results, requests }, null, 2))
  console.log(JSON.stringify({ passed: true, protocols: results.map(result => result.protocol), requestCount: requests.length, externalAPIListenerUsed: false, evidence: path.join(scratch, 'report.json') }))
})().catch(error => {
  fs.writeFileSync(path.join(scratch, 'failure.json'), JSON.stringify({ error: error.stack, results, requests }, null, 2))
  console.error(error.stack); console.error('Evidence:', scratch); process.exitCode = 1
}).finally(() => {
  clearTimeout(deadline)
  services.forEach(service => service.dispose())
  server.closeAllConnections()
  server.close()
})
