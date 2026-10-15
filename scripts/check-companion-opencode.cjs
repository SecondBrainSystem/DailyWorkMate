// Actual project-local OpenCode, isolated workspaces, deterministic OpenAI-compatible mock.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..')
const scratch = path.join(root, 'tmp', 'companion-agent-' + process.pid)
fs.mkdirSync(path.join(scratch, 'workspace'), { recursive: true })
fs.writeFileSync(path.join(scratch, 'workspace', 'hello.txt'), 'COMPANION_READ_SUCCESS')
fs.mkdirSync(path.join(scratch, 'private'))
fs.writeFileSync(path.join(scratch, 'private', 'secret.txt'), 'OUTSIDE_SECRET_MUST_NOT_REACH_MODEL')
fs.symlinkSync(path.join(scratch, 'private'), path.join(scratch, 'workspace', 'link'), process.platform === 'win32' ? 'junction' : 'dir')
buildSync({ entryPoints: [path.join(root, 'src/main/companion/opencode.ts')], outfile: path.join(scratch, 'service.cjs'), bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
const { OpenCodeService } = require(path.join(scratch, 'service.cjs'))
let requests = []
let grant = { id: 'qa', path: fs.realpathSync(path.join(scratch, 'workspace')), name: 'QA workspace', writable: false }
let pending = []
let service
let extraGrants = []
let groups = []
const server = http.createServer(async (req, res) => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  if (req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return }
  try {
    assert.equal(req.headers.authorization, 'Bearer qa-secret')
    assert.equal(req.headers['x-dailyworkmate-model-selection'], 'explicit')
    const body = JSON.parse(raw)
    requests = [...requests, body]
    const all = JSON.stringify(body.messages)
    const userText = [...body.messages].reverse().find(message => message.role === 'user')?.content || ''
    if (JSON.stringify(userText).includes('WAIT_QA')) { pending.push(res); return }
    const toolDone = body.messages.some(message => message.role === 'tool')
    let call
    if (!toolDone && all.includes('READ_QA')) call = { name: 'read', arguments: JSON.stringify({ path: path.join(grant.path, 'hello.txt') }) }
    if (!toolDone && all.includes('WRITE_QA')) call = { name: 'write', arguments: JSON.stringify({ path: path.join(grant.path, 'written.txt'), content: 'COMPANION_WRITE_SUCCESS' }) }
    if (!toolDone && all.includes('COMMAND_QA')) call = { name: 'shell', arguments: JSON.stringify({ command: 'echo COMPANION_COMMAND_SUCCESS', description: 'Print a test marker' }) }
    if (!toolDone && all.includes('LOCKED_COMMAND_QA')) call = { name: 'shell', arguments: JSON.stringify({ command: 'echo MUST_NOT_RUN > readonly-shell.txt', description: 'Attempt a command in a read-only workspace' }) }
    if (!toolDone && all.includes('ESCAPE_QA')) call = { name: 'read', arguments: JSON.stringify({ path: path.join(grant.path, 'link', 'secret.txt') }) }
    if (!toolDone && all.includes('READONLY_QA')) call = { name: 'write', arguments: JSON.stringify({ path: path.join(grant.path, 'forbidden.txt'), content: 'MUST_NOT_WRITE' }) }
    if (!toolDone && all.includes('GROUP_MEMBER_QA')) call = { name: 'read', arguments: JSON.stringify({ path: path.join(extraGrants[0].path, 'member.txt') }) }
    if (!toolDone && all.includes('GROUP_NONMEMBER_QA')) call = { name: 'read', arguments: JSON.stringify({ path: path.join(extraGrants[1].path, 'unrelated.txt') }) }
    if (!toolDone && all.includes('GROUP_READONLY_QA')) call = { name: 'write', arguments: JSON.stringify({ path: path.join(extraGrants[0].path, 'forbidden.txt'), content: 'MUST_NOT_WRITE' }) }
    if (!toolDone && all.includes('NARROW_INSIDE_QA')) call = { name: 'read', arguments: JSON.stringify({ path: path.join(grant.path, 'docs', 'inside.txt') }) }
    if (!toolDone && all.includes('NARROW_PARENT_QA')) call = { name: 'read', arguments: JSON.stringify({ path: path.join(grant.path, 'hello.txt') }) }
    if (!toolDone && all.includes('NARROW_OTHER_QA')) call = { name: 'read', arguments: JSON.stringify({ path: path.join(extraGrants[0].path, 'member.txt') }) }
    if (!toolDone && all.includes('NARROW_LINK_QA')) call = { name: 'read', arguments: JSON.stringify({ path: path.join(grant.path, 'docs', 'escape', 'member.txt') }) }
    if (!toolDone && all.includes('NARROW_WRITE_QA')) call = { name: 'write', arguments: JSON.stringify({ path: path.join(grant.path, 'docs', 'written.txt'), content: 'NARROW_WRITE_SUCCESS' }) }
    if (!toolDone && all.includes('NARROW_LOCKED_QA')) call = { name: 'write', arguments: JSON.stringify({ path: path.join(grant.path, 'docs', 'locked', 'forbidden.txt'), content: 'MUST_NOT_WRITE' }) }
    if (!toolDone && all.includes('NARROW_COMMAND_QA')) call = { name: 'shell', arguments: JSON.stringify({ command: 'echo NARROW_COMMAND_MUST_NOT_RUN', description: 'Attempt a command inside a restricted scope' }) }
    if (call && !all.includes('READONLY_QA') && !all.includes('NARROW_COMMAND_QA') && !all.includes('LOCKED_COMMAND_QA') && !body.tools?.some(tool => tool.function?.name === call.name)) throw new Error('Tool unavailable: ' + call.name + '. Available: ' + body.tools?.map(tool => tool.function?.name))
    const content = all.includes('GROUP_MEMBER_READ_SUCCESS') ? 'Read confirmed: GROUP_MEMBER_READ_SUCCESS' : all.includes('COMPANION_READ_SUCCESS') ? 'Read confirmed: COMPANION_READ_SUCCESS' : 'Task completed by QA model'
    const choice = call ? { delta: { tool_calls: [{ index: 0, id: 'call_qa_' + requests.length, type: 'function', function: call }] }, finish_reason: 'tool_calls' } : { delta: { content }, finish_reason: 'stop' }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('data: ' + JSON.stringify({ id: 'qa-' + requests.length, object: 'chat.completion.chunk', created: 1, model: 'qa-model', choices: [{ index: 0, ...choice }] }) + '\n\n')
    res.end('data: [DONE]\n\n')
  } catch (error) { console.error(error.message); res.writeHead(500).end(JSON.stringify({ error: { message: error.message } })) }
})
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function run(prompt, groupId, scope = {}) {
  let status = await service.start({ workspaceId: grant.id, model: 'qa-model', prompt, newSession: true, groupId, ...scope })
  for (let i = 0; i < 180 && status.running; i++) {
    await sleep(500)
    status = await service.poll()
    assert.deepEqual(status.permissions, [], 'Chat commands must not request additional approval')
  }
  assert.equal(status.running, false, 'Agent timed out: ' + JSON.stringify(status))
  assert.equal(status.error, '', status.error)
  return status
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const storage = {
    home: scratch,
    get: async () => ({ settings: { persona: 'You are a test assistant.' }, workspaces: [grant, ...extraGrants], groups }),
    grant: async () => grant,
  }
  // Link only the known local runtime; all runtime data stays under the scratch directory.
  fs.symlinkSync(path.join(root, 'companion', 'runtime'), path.join(scratch, 'runtime'), process.platform === 'win32' ? 'junction' : 'dir')
  service = new OpenCodeService(storage, () => ({ proxyHost: '127.0.0.1', proxyPort: server.address().port, enableApiKey: true, apiKeys: [{ key: 'qa-secret', enabled: true }] }))
  assert.ok(service.available())
  const read = await run('READ_QA: Read hello.txt')
  fs.writeFileSync(path.join(scratch, 'read-result.json'), JSON.stringify({ read, requests }, null, 2))
  assert.match(read.text, /COMPANION_READ_SUCCESS/)
  assert.ok(read.tools.some(tool => tool.name === 'read' && tool.status === 'completed'))
  console.log('PASS: authenticated proxy, actual OpenCode file read, task activity')
  const sessionId = read.sessionId
  service.dispose()
  service = new OpenCodeService(storage, () => ({ proxyHost: '127.0.0.1', proxyPort: server.address().port, enableApiKey: true, apiKeys: [{ key: 'qa-secret', enabled: true }] }))
  let resumed = await service.start({ workspaceId: grant.id, model: 'qa-model', prompt: 'Continue the same conversation', sessionId })
  while (resumed.running) { await sleep(500); resumed = await service.poll() }
  assert.equal(resumed.sessionId, sessionId)
  assert.equal(resumed.error, '')
  assert.ok(JSON.stringify(requests.at(-1).messages).includes('READ_QA'))
  console.log('PASS: OpenCode conversation resumes after service restart')
  const escape = await run('ESCAPE_QA: Try reading a symlink outside the grant')
  assert.ok(escape.tools.some(tool => tool.status === 'error'))
  assert.ok(!JSON.stringify(requests).includes('OUTSIDE_SECRET_MUST_NOT_REACH_MODEL'))
  await run('READONLY_QA: Try creating forbidden.txt')
  assert.ok(!fs.existsSync(path.join(grant.path, 'forbidden.txt')))
  const readonlyCommand = await run('LOCKED_COMMAND_QA: Attempt a command in this read-only workspace')
  assert.ok(readonlyCommand.tools.some(tool => tool.name === 'shell' && tool.status === 'error'))
  assert.ok(!fs.existsSync(path.join(grant.path, 'readonly-shell.txt')))
  console.log('PASS: actual runtime denies symlink escapes, read-only writes and commands')
  grant = { ...grant, writable: true }
  await run('WRITE_QA: Create written.txt')
  assert.equal(fs.readFileSync(path.join(grant.path, 'written.txt'), 'utf8'), 'COMPANION_WRITE_SUCCESS')
  console.log('PASS: authorized file write')
  for (let attempt = 0; attempt < 2; attempt++) {
    const beforeCommand = requests.length
    const command = await run('COMMAND_QA: Run the test command')
    assert.ok(command.tools.some(tool => tool.name === 'shell' && tool.status === 'completed'))
    assert.ok(requests.slice(beforeCommand).some(request => request.messages.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('COMPANION_COMMAND_SUCCESS'))), 'The command must execute and return its actual output')
  }
  console.log('PASS: authorized shell commands execute automatically without approval replies')
  await service.start({ workspaceId: grant.id, model: 'qa-model', prompt: 'WAIT_QA', newSession: true })
  await sleep(1000)
  await service.stop()
  assert.equal((await service.poll()).running, false)
  console.log('PASS: abort pending task')
  for (const name of ['member', 'unrelated']) fs.mkdirSync(path.join(scratch, name))
  fs.writeFileSync(path.join(scratch, 'member', 'member.txt'), 'GROUP_MEMBER_READ_SUCCESS')
  fs.writeFileSync(path.join(scratch, 'unrelated', 'unrelated.txt'), 'UNRELATED_GROUP_DATA_MUST_NOT_REACH_MODEL')
  extraGrants = ['member', 'unrelated'].map(id => ({id,path:fs.realpathSync(path.join(scratch,id)),name:id,writable:false}))
  groups = [{id:'group-a',name:'Group A',workspaceIds:['qa','member']},{id:'group-b',name:'Group B',workspaceIds:['qa']}]
  const grouped = await run('GROUP_MEMBER_QA: Read the other group folder', 'group-a')
  assert.match(grouped.text, /GROUP_MEMBER_READ_SUCCESS/)
  assert.ok(grouped.tools.some(tool => tool.name === 'read' && tool.status === 'completed'))
  await assert.rejects(service.start({workspaceId:grant.id,model:'qa-model',prompt:'Continue',sessionId:grouped.sessionId,groupId:'group-b'}), /another workspace group/)
  const blockedGroup = await run('GROUP_NONMEMBER_QA: Try reading an authorized folder outside this group', 'group-a')
  assert.ok(blockedGroup.tools.some(tool => tool.status === 'error'))
  assert.ok(!JSON.stringify(requests).includes('UNRELATED_GROUP_DATA_MUST_NOT_REACH_MODEL'))
  await run('GROUP_READONLY_QA: Try writing a read-only group folder', 'group-a')
  assert.ok(!fs.existsSync(path.join(extraGrants[0].path, 'forbidden.txt')))
  console.log('PASS: grouped cross-folder reads, nonmember denial, per-folder read-only rules and native session isolation')
  fs.mkdirSync(path.join(grant.path, 'docs', 'locked'), { recursive: true })
  fs.writeFileSync(path.join(grant.path, 'docs', 'inside.txt'), 'NARROW_ALLOWED_CONTENT')
  fs.symlinkSync(extraGrants[0].path, path.join(grant.path, 'docs', 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  extraGrants = [...extraGrants, { id:'locked', path:fs.realpathSync(path.join(grant.path,'docs','locked')), name:'locked', writable:false }]
  groups = groups.map(group => group.id === 'group-a' ? { ...group, workspaceIds:[...group.workspaceIds,'locked'] } : group)
  const subfolder = { accessScope:'folder', relativePath:'docs' }
  const beforeNarrow = requests.length
  const inside = await run('NARROW_INSIDE_QA: Read inside this subfolder', 'group-a', subfolder)
  assert.ok(inside.tools.some(tool => tool.name === 'read' && tool.status === 'completed'))
  assert.ok(JSON.stringify(requests.slice(beforeNarrow)).includes('NARROW_ALLOWED_CONTENT'))
  for (const marker of ['NARROW_PARENT_QA','NARROW_OTHER_QA','NARROW_LINK_QA']) {
    const before = requests.length
    const blocked = await run(marker + ': Attempt out-of-scope access', 'group-a', subfolder)
    assert.ok(blocked.tools.some(tool => tool.status === 'error'), marker)
    assert.ok(!JSON.stringify(requests.slice(before)).includes('COMPANION_READ_SUCCESS'), marker)
    assert.ok(!JSON.stringify(requests.slice(before)).includes('GROUP_MEMBER_READ_SUCCESS'), marker)
  }
  await run('NARROW_WRITE_QA: Write within this subfolder', 'group-a', subfolder)
  assert.equal(fs.readFileSync(path.join(grant.path,'docs','written.txt'),'utf8'),'NARROW_WRITE_SUCCESS')
  await run('NARROW_LOCKED_QA: Attempt a write inside the nested read-only grant', 'group-a', subfolder)
  assert.ok(!fs.existsSync(path.join(grant.path,'docs','locked','forbidden.txt')))
  const shellBlocked = await run('NARROW_COMMAND_QA: Attempt shell access from a restricted directory', 'group-a', subfolder)
  assert.ok(shellBlocked.tools.some(tool => tool.status === 'error'))
  await assert.rejects(service.start({ workspaceId:grant.id,groupId:'group-a',model:'qa-model',prompt:'Reuse a broader session',sessionId:grouped.sessionId,...subfolder }), /folder scope/)
  await assert.rejects(service.start({ workspaceId:grant.id,groupId:'group-a',model:'qa-model',prompt:'Invalid target',newSession:true,accessScope:'folder',relativePath:'../member' }), /inside the authorized/)
  console.log('PASS: actual subfolder read/write, parent/other-member/junction denial, nested read-only rules and scope-bound sessions')
  service.dispose()
  let release
  const gate = new Promise(resolve => { release = resolve })
  const slowStorage = { ...storage, get: async () => { await gate; return storage.get() } }
  service = new OpenCodeService(slowStorage, () => ({ proxyHost: '127.0.0.1', proxyPort: server.address().port, enableApiKey: false, apiKeys: [] }))
  const starting = service.start({ workspaceId: grant.id, model: 'qa-model', prompt: 'cancel during startup' })
  await service.stop()
  release()
  await assert.rejects(starting, /cancelled/)
  console.log('PASS: cancellation before runtime startup does not launch a task')
})().catch(error => { console.error(error.message); console.error('QA output:', scratch); process.exitCode = 1 }).finally(() => {
  service?.dispose()
  pending.forEach(response => response.destroy())
  server.closeAllConnections()
  server.close()
})
