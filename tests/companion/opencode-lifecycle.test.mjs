import test, { before, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const output = path.resolve('tmp/qa/opencode-lifecycle.mjs')
let fixtureModule, service, input, saved
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const flush = () => new Promise(resolve => setImmediate(resolve))
const reply = text => [{ info: { id: 'assistant_1', role: 'assistant' }, parts: [{ id: 'text_1', type: 'text', text }] }]

before(async () => {
  await mkdir(path.dirname(output), { recursive: true })
  const sources = {
    state: `export let state = {};
      export function reset() { state = { guardError:false, guards:0, spawns:0, kills:0, prompts:[], messages:[], sessions:0, imported:[], interruptions:[], streams:[], closedStreams:0 }; }
      export function configure(change) { state = { ...state, ...change }; }
      export function deferred() { let resolve, reject; const promise = new Promise((yes,no) => { resolve=yes; reject=no; }); return {promise,resolve,reject}; }`,
    child: `import { EventEmitter } from 'node:events'; import { state, configure } from 'qa:state';
      export function execFile() { throw new Error('Unexpected real process cleanup in lifecycle fixture'); }
      export function spawn(command, args, options) {
        const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        child.killed = false; child.kill = () => { configure({kills:state.kills+1}); child.killed = true; child.emit('exit', 0); };
        if (command === 'taskkill') return child;
        configure({spawns:state.spawns+1,cwd:options.cwd,env:options.env});
        queueMicrotask(() => child.stdout.emit('data', Buffer.from('http://127.0.0.1:41234')));
        return child;
      }`,
    net: `import { EventEmitter } from 'node:events'; export function createServer() {
      const server = new EventEmitter(); server.listen = (_port,_host,fn) => queueMicrotask(fn);
      server.address = () => ({port:41234}); server.close = fn => fn?.(); return server;
    }`,
    client: `import { state, configure, deferred } from 'qa:state';
      export class OpenCodeV2Client {
        constructor(_address,_password,directory) { this.directory=directory; }
        async health() { if(state.health) await state.health.promise; }
        async location() { return {directory:this.directory,worktree:this.directory}; }
        async assertGuard() { configure({guards:state.guards+1}); if(state.guardError) throw new Error('Workspace guard is not active'); }
        async getSession(id) { return {id,directory:this.directory}; }
        async createSession() { const sessions=state.sessions+1; configure({sessions}); return {id:'session_'+sessions,directory:this.directory}; }
        async messages() { configure({messageCalls:(state.messageCalls||0)+1}); const next=state.nextMessages; if(next) {configure({nextMessages:null}); return next.promise;} return state.messages; }
        async permissions() { configure({permissionCalls:(state.permissionCalls||0)+1}); return state.permissions||[]; }
        async reply(id,requestId,allow) { configure({replies:[...(state.replies||[]),{id,requestId,allow}]}); }
        async addHistory(id,text) { configure({imported:[...state.imported,{id,text}]}); }
        async setInstructions(id,text) { configure({terminalInstructions:{id,text}}); }
        async selectModel(id,model) { configure({terminalModel:{id,model}}); const wait=state.selecting; if(wait) { configure({selecting:null,selectingStarted:true}); await wait.promise; } }
        async subscribeSession(id,onEvent,onError,signal) { if(state.subscriptionError) throw new Error('Events unavailable'); const stream={id,onEvent,onError,signal}; configure({streams:[...state.streams,stream]}); let closed=false; return {close:()=>{if(!closed) {closed=true;configure({closedStreams:state.closedStreams+1});}}}; }
        prompt(id,input,signal) { const pending={...deferred(),id,input,signal}; configure({prompts:[...state.prompts,pending]}); return pending.promise; }
        async abort(id) { configure({interruptions:[...state.interruptions,id]}); if(state.interrupt) await state.interrupt.promise; }
      }`,
    config: `import { configure } from 'qa:state'; export function buildOpenCodeV2Config(grants,selected,model,_base,worktree,_free,_guard,allowShell=true,autoApproveCommands=false,connection) {
      const shellEffect=selected.writable && allowShell ? autoApproveCommands ? 'allow' : 'ask' : 'deny';
      const configuration={allowShell,autoApproveCommands,shellEffect}; configure({grants,configuration});
      return {directory:selected.path,model:connection?.model||model,baseURL:connection?.baseURL,protocol:connection?.protocol,headers:connection?.headers,worktree,grants,shellPermission:shellEffect}; }`,
    guard: `export async function installWorkspaceGuardV2() {}`,
    runtime: `export const managedRuntimeExecutable = () => undefined; export async function rollbackManagedRuntime() { throw new Error('Unexpected rollback'); }`,
    models: `export const isOpenCodeFreeModel = () => false; export async function resolveOpenCodeFreeModel() { throw new Error('Unexpected free-model lookup'); }`,
  }
  await build({
    stdin: { contents: `export { OpenCodeService } from './src/main/companion/opencode.ts'; export { state, configure, reset } from 'qa:state';`, resolveDir: process.cwd() },
    outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external',
    plugins: [{ name: 'isolate-opencode-lifecycle', setup(builder) {
      const map = { 'node:child_process':'child', 'node:net':'net', './opencodeV2':'client', './opencodeV2Config':'config',
        './workspaceGuardV2':'guard', './runtimeUpdates':'runtime', './opencodeModels':'models', 'qa:state':'state' }
      builder.onResolve({filter: /^(?:node:(?:child_process|net)|qa:state|\.\/(?:opencodeV2|opencodeV2Config|workspaceGuardV2|runtimeUpdates|opencodeModels))$/}, args => ({path:map[args.path],namespace:'qa'}))
      builder.onLoad({filter:/.*/,namespace:'qa'}, args => ({contents:sources[args.path],resolveDir:process.cwd()}))
    } }],
  })
  fixtureModule = await import(pathToFileURL(output).href)
})

beforeEach(async () => {
  fixtureModule.reset()
  const home = await mkdtemp(path.resolve('tmp/qa/lifecycle-'))
  const workspace = path.join(home, 'workspace')
  await mkdir(workspace)
  const executable = path.join(home, 'opencode.exe')
  await writeFile(executable, 'mock runtime is never executed')
  const grant = { id:'qa',path:workspace,name:'workspace',writable:false }
  saved = {settings:{persona:'test'},workspaces:[grant],groups:[]}
  service = new fixtureModule.OpenCodeService({home,get:async()=>saved,grant:async()=>grant},
    ()=>({proxyHost:'127.0.0.1',proxyPort:11434,enableApiKey:false,apiKeys:[]}),executable,undefined,{refreshIntervals:{messages:0,live:0,permissions:0}})
  input = {workspaceId:'qa',model:'qa-model',prompt:'List this folder',newSession:true}
})
afterEach(() => service?.dispose())

test('native Work resolves the real endpoint and model without reading external proxy settings', async () => {
  const home = path.dirname(saved.workspaces[0].path)
  const connection = { baseURL:'https://models.example.test/v1', apiKey:'synthetic-upstream-key', model:'actual-model', protocol:'openai', direct:true, headers:{'X-Project':'synthetic-project-secret'} }
  const resolved = []
  service = new fixtureModule.OpenCodeService({home,get:async()=>saved},
    () => { throw new Error('External proxy must not be used') }, path.join(home,'opencode.exe'),
    async model => { resolved.push(model); return connection })
  const terminal = await service.prepareTerminal(input)
  assert.equal(terminal.remoteSessionId, 'session_1')
  assert.deepEqual(resolved, ['qa-model'])
  assert.deepEqual(fixtureModule.state.terminalModel.model, {providerID:'dailyworkmate',modelID:'actual-model'})
  assert.equal(fixtureModule.state.env.DAILYWORKMATE_PROXY_KEY, connection.apiKey)
  assert.equal(fixtureModule.state.env.DAILYWORKMATE_MODEL_HEADER_0, 'synthetic-project-secret')
  const configuration = await readFile(fixtureModule.state.env.OPENCODE_CONFIG, 'utf8')
  assert.match(configuration, /https:\/\/models.example.test\/v1/)
  assert.match(configuration, /DAILYWORKMATE_MODEL_HEADER_0/)
  assert.doesNotMatch(configuration, /synthetic-upstream-key|synthetic-project-secret|11434/)
})

test('native Work server identity changes with resolved endpoint, credentials and actual model', async () => {
  const home = path.dirname(saved.workspaces[0].path)
  let connection = { baseURL:'https://models.example.test/v1', apiKey:'first-key', model:'first-model', protocol:'openai', direct:true }
  service = new fixtureModule.OpenCodeService({home,get:async()=>saved},
    () => { throw new Error('External proxy must not be used') }, path.join(home,'opencode.exe'), async () => connection)
  await service.prepareTerminal(input)
  await service.prepareTerminal(input)
  assert.equal(fixtureModule.state.spawns, 1)
  for (const change of [{baseURL:'https://other.example.test/v1'}, {apiKey:'second-key'}, {model:'second-model'}]) {
    connection = {...connection,...change}
    await service.prepareTerminal(input)
  }
  assert.equal(fixtureModule.state.spawns, 4)
  assert.equal(fixtureModule.state.kills, 0, 'existing tasks retain their own model connection')
})

test('ordinary chat runs V2 in an isolated readonly directory without inheriting saved workspaces', async () => {
  saved = { ...saved, workspaces:saved.workspaces.map(grant => ({ ...grant, writable:true })),
    groups:[{ id:'personal', name:'Personal', workspaceIds:['qa'] }] }
  const before = structuredClone(saved)
  const result = await service.start({ ...input, workspaceId:'', systemPrompt:'请自然地使用中文回答。',
    history:[{ role:'user', content:'Earlier question' }, { role:'assistant', content:'Earlier reply' }] })
  const state = fixtureModule.state
  assert.equal(result.running, true)
  assert.equal(state.guards, 1)
  assert.deepEqual(state.configuration, { allowShell:false, autoApproveCommands:false, shellEffect:'deny' })
  assert.equal(state.grants.length, 1)
  assert.equal(state.grants[0].writable, false)
  assert.equal(state.cwd, state.grants[0].path)
  assert.equal(state.cwd, path.join(path.dirname(saved.workspaces[0].path), 'data', 'opencode-v2', 'chat-workspace'))
  assert.deepEqual(await readdir(state.cwd), [])
  assert.deepEqual(saved, before, 'internal chat access must not become a saved user workspace')
  assert.ok(state.prompts[0].input.system.startsWith('请自然地使用中文回答。\n\n'))
  assert.match(state.prompts[0].input.system, /ordinary chat mode.*No user workspace is connected/)
  assert.match(state.prompts[0].input.system, /select the appropriate workspace/)
  assert.doesNotMatch(state.prompts[0].input.system, /You are now in workspace mode|Current workspace group/)
  assert.ok(!state.prompts[0].input.system.includes(saved.workspaces[0].path))
  assert.match(state.imported[0].text, /Earlier reply/)
})

test('ordinary chat works without saved grants and retains its session across unrelated grant changes', async () => {
  const original = saved.workspaces[0]
  saved = { ...saved, workspaces:[] }
  const first = await service.start({ ...input, workspaceId:'' })
  fixtureModule.state.prompts[0].resolve()
  await flush()
  saved = { ...saved, workspaces:[{ ...original, writable:true }] }
  assert.deepEqual([...await service.staleAttachments()], [])
  assert.equal(fixtureModule.state.kills, 0)
  const second = await service.start({ ...input, workspaceId:'', newSession:false, sessionId:first.sessionId })
  assert.equal(second.sessionId, first.sessionId)
  assert.equal(fixtureModule.state.spawns, 1)
  assert.equal(fixtureModule.state.sessions, 1)
})

test('ordinary chat keeps partial output and honors cancellation before another turn starts', async () => {
  await service.start({ ...input, workspaceId:'' })
  fixtureModule.configure({ messages:reply('Partial ordinary answer') })
  assert.equal((await service.poll()).text, 'Partial ordinary answer')
  const first = fixtureModule.state.prompts[0]
  await service.stop()
  assert.equal(first.signal.aborted, true)
  const stopped = await service.poll()
  assert.equal(stopped.running, false)
  assert.equal(stopped.text, 'Partial ordinary answer')
  await service.start({ ...input, workspaceId:'' })
  assert.equal(fixtureModule.state.prompts[1].signal.aborted, false)
})

test('ordinary chat rejects workspace scope metadata and terminal startup still requires a real workspace', async () => {
  for (const scope of [{ groupId:'personal' }, { relativePath:'src' }, { accessScope:'folder' }, { groupId:12 }]) {
    await assert.rejects(service.start({ ...input, workspaceId:'', ...scope }), /Select a workspace/)
  }
  await assert.rejects(service.prepareTerminal({ ...input, workspaceId:'', cols:100, rows:30 }), /workspace ID/)
  assert.equal(fixtureModule.state.spawns, 0)
  assert.equal(fixtureModule.state.prompts.length, 0)
})

test('ordinary chat and a selected workspace cannot resume each other’s sessions', async () => {
  const ordinary = await service.start({ ...input, workspaceId:'' })
  await service.stop()
  await assert.rejects(service.start({ ...input, newSession:false, sessionId:ordinary.sessionId }), /another workspace group or folder scope/)
  const selected = await service.start(input)
  await service.stop()
  await assert.rejects(service.start({ ...input, workspaceId:'', newSession:false, sessionId:selected.sessionId }), /another workspace group or folder scope/)
  assert.equal(fixtureModule.state.prompts.length, 2)
})

test('ordinary chat rejects an internal directory replaced by a link to user files', async () => {
  const parent = path.join(path.dirname(saved.workspaces[0].path), 'data', 'opencode-v2')
  await mkdir(parent, { recursive:true })
  await symlink(saved.workspaces[0].path, path.join(parent, 'chat-workspace'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(service.start({ ...input, workspaceId:'' }), /Folder target changed/)
  assert.equal(fixtureModule.state.spawns, 0)
  assert.equal(fixtureModule.state.prompts.length, 0)
})

test('terminal preparation validates its guard and instructions without sending a model prompt', async () => {
  const prepared = await service.prepareTerminal({ ...input, cols:100, rows:30 })
  assert.equal(fixtureModule.state.guards, 1)
  assert.equal(fixtureModule.state.prompts.length, 0)
  assert.equal(fixtureModule.state.terminalModel.model.modelID, 'qa-model')
  assert.ok(fixtureModule.state.terminalInstructions.text.includes('READ ONLY'))
  assert.ok(prepared.sessionId.startsWith('v2:'))
  assert.equal(service.isBusy(), true)
  await service.dispose()
  assert.equal(service.isBusy(), false)
})

test('terminal guard failures fail closed before preparing a native session', async () => {
  fixtureModule.configure({guardError:true})
  await assert.rejects(service.prepareTerminal({ ...input, cols:100, rows:30 }), /guard/)
  assert.equal(fixtureModule.state.sessions, 0)
  assert.equal(fixtureModule.state.prompts.length, 0)
  assert.equal(service.isBusy(), false)
})

test('authorized writable chat and assistant sessions configure automatic native shell permission', async () => {
  saved = { ...saved, workspaces:saved.workspaces.map(grant => ({ ...grant, writable:true })) }
  await service.start({ ...input, groupId:'', accessScope:'group', systemPrompt:'请直接执行已授权工作区的命令。' })
  assert.deepEqual(fixtureModule.state.configuration, { allowShell:true, autoApproveCommands:true, shellEffect:'allow' })
  assert.match(fixtureModule.state.prompts[0].input.system, /without requesting further approval/)
  assert.doesNotMatch(fixtureModule.state.prompts[0].input.system, /commands always need user approval/)
})

test('automatic chat command policy keeps readonly and restricted folder commands denied', async () => {
  await service.start(input)
  assert.deepEqual(fixtureModule.state.configuration, { allowShell:false, autoApproveCommands:false, shellEffect:'deny' })
  assert.match(fixtureModule.state.prompts[0].input.system, /READ ONLY, so shell commands are disabled/)
  await service.stop()
  saved = { ...saved, workspaces:saved.workspaces.map(grant => ({ ...grant, writable:true })) }
  await service.start({ ...input, accessScope:'folder' })
  assert.deepEqual(fixtureModule.state.configuration, { allowShell:false, autoApproveCommands:false, shellEffect:'deny' })
  assert.match(fixtureModule.state.prompts[1].input.system, /restricted folder scope.*Shell commands are disabled/)
})

test('chat automatic command servers remain separate from native Work approval servers and can be reused', async () => {
  saved = { ...saved, workspaces:saved.workspaces.map(grant => ({ ...grant, writable:true })) }
  const scope = { ...input, groupId:'', accessScope:'group' }
  const chat = await service.start(scope)
  fixtureModule.state.prompts[0].resolve()
  await flush()
  assert.equal((await service.poll()).running, false)
  const terminal = await service.prepareTerminal({ ...scope, cols:100, rows:30 })
  assert.deepEqual(fixtureModule.state.configuration, { allowShell:true, autoApproveCommands:false, shellEffect:'ask' })
  assert.match(fixtureModule.state.terminalInstructions.text, /Shell commands require approval/)
  assert.equal(fixtureModule.state.spawns, 2, 'manual Work approval must use a different guarded server from automatic chat commands')
  assert.deepEqual([...await service.staleAttachments()], [], 'both modes remain valid while the folder grants are unchanged')
  await service.releaseTerminal(terminal.attachment)
  assert.equal(fixtureModule.state.kills, 1, 'releasing Work closes only its own manual approval server')
  await service.start({ ...scope, newSession:false, sessionId:chat.sessionId })
  assert.equal(fixtureModule.state.spawns, 2, 'the automatically authorized chat server is reused')
  assert.equal(fixtureModule.state.configuration.shellEffect, 'allow')
})

test('readonly Chat and Work isolate their command modes even when both configurations deny shell', async () => {
  const scope = { ...input, groupId:'', accessScope:'group' }
  const chat = await service.start(scope)
  assert.deepEqual(fixtureModule.state.configuration, { allowShell:false, autoApproveCommands:false, shellEffect:'deny' })
  fixtureModule.state.prompts[0].resolve()
  await flush()
  assert.equal((await service.poll()).running, false)
  const terminal = await service.prepareTerminal({ ...scope, cols:100, rows:30 })
  assert.deepEqual(fixtureModule.state.configuration, { allowShell:true, autoApproveCommands:false, shellEffect:'deny' })
  assert.equal(fixtureModule.state.spawns, 2, 'readonly shell policies are identical, so server identity must still distinguish the command modes')
  assert.deepEqual([...await service.staleAttachments()], [], 'matching grants do not stale either command mode')
  await service.releaseTerminal(terminal.attachment)
  assert.equal(fixtureModule.state.kills, 1, 'releasing the readonly Work server leaves its Chat server available')
  await service.start({ ...scope, newSession:false, sessionId:chat.sessionId })
  assert.equal(fixtureModule.state.spawns, 2, 'readonly Chat reuses its server after the Work attachment closes')
  assert.deepEqual(fixtureModule.state.configuration, { allowShell:false, autoApproveCommands:false, shellEffect:'deny' })
})

test('revoking writable chat access retires its automatic command server before another task', async () => {
  const readonly = saved.workspaces[0]
  saved = { ...saved, workspaces:[{ ...readonly, writable:true }] }
  await service.start(input)
  fixtureModule.state.prompts[0].resolve()
  await flush()
  saved = { ...saved, workspaces:[readonly] }
  assert.deepEqual([...await service.staleAttachments()], [])
  assert.equal(fixtureModule.state.kills, 1, 'automatic permission must not survive revoking the writable grant')
  await service.start(input)
  assert.equal(fixtureModule.state.spawns, 2)
  assert.deepEqual(fixtureModule.state.configuration, { allowShell:false, autoApproveCommands:false, shellEffect:'deny' })
})

test('repeated guard failure never reuses an unvalidated server or dispatches a prompt', async () => {
  fixtureModule.configure({guardError:true})
  await assert.rejects(service.start(input), /guard is not active/)
  await assert.rejects(service.start(input), /guard is not active/)
  assert.equal(fixtureModule.state.guards, 2)
  assert.equal(fixtureModule.state.spawns, 2)
  assert.equal(fixtureModule.state.prompts.length, 0)
  assert.equal(service.isBusy(), false)
  fixtureModule.configure({guardError:false})
  assert.equal((await service.start(input)).running, true)
  assert.equal(fixtureModule.state.guards, 3, 'a replacement must validate its guard before the first model request')
  assert.equal(fixtureModule.state.prompts.length, 1)
})

test('stop blocks a new task until interruption completes and never cancels its successor', async () => {
  await service.start(input)
  const first = fixtureModule.state.prompts[0]
  const interrupt = deferred()
  fixtureModule.configure({interrupt})
  const stopped = service.stop()
  assert.equal(first.signal.aborted, true)
  assert.equal(service.isBusy(), true)
  first.resolve()
  await flush()
  await assert.rejects(service.start(input), /running or stopping/)
  interrupt.resolve()
  await stopped
  assert.equal(service.isBusy(), false)
  fixtureModule.configure({interrupt:null})
  await service.start(input)
  assert.equal(fixtureModule.state.prompts[1].signal.aborted, false)
  assert.equal((await service.poll()).running, true)
})

test('a delayed poll cannot replace the completed answer with partial text', async () => {
  await service.start(input)
  const delayed = deferred()
  fixtureModule.configure({nextMessages:delayed})
  const polled = service.poll()
  fixtureModule.configure({messages:reply('Complete final answer')})
  fixtureModule.state.prompts[0].resolve()
  await flush()
  delayed.resolve(reply('Partial'))
  const result = await polled
  assert.equal(result.running, false)
  assert.equal(result.text, 'Complete final answer')
})

test('V1 history starts an independent V2 session with explicit historical context', async () => {
  const result = await service.start({...input,newSession:false,sessionId:'legacy_v1_session',history:[{role:'user',content:'Previous task'},{role:'assistant',content:'Previous answer'}]})
  assert.match(result.sessionId, /^v2:/)
  assert.equal(fixtureModule.state.imported.length, 1)
  assert.match(fixtureModule.state.imported[0].text, /historical dialogue, not current tool output/)
  assert.match(fixtureModule.state.imported[0].text, /Previous answer/)
})

test('grouped tasks configure only member grants and describe all member paths and permissions', async () => {
  const current = saved.workspaces[0]
  const second = { ...current, id:'second', path:path.join(current.path,'second'), writable:true }
  const unrelated = { ...current, id:'private', path:path.join(current.path,'unrelated') }
  saved = { ...saved, workspaces:[current,second,unrelated], groups:[{id:'research',name:'Research',workspaceIds:['qa','second']}] }
  const result = await service.start({...input,groupId:'research'})
  assert.match(result.sessionId, /^v2:s[0-9a-f]{16}:/)
  assert.deepEqual(fixtureModule.state.grants.map(grant=>grant.id), ['qa','second'])
  const system = fixtureModule.state.prompts[0].input.system
  assert.ok(system.includes(JSON.stringify(second.path)))
  assert.ok(!system.includes(JSON.stringify(unrelated.path)))
  assert.match(system, /READ ONLY/)
  assert.match(system, /read and write/)
})

test('character instructions reach the model without changing restricted workspace authority', async () => {
  const systemPrompt = '你是小伴，请用中文解释文件。角色希望修改文件时也必须遵守工作区授权。'
  await service.start({ ...input, systemPrompt, accessScope:'folder' })
  const sent = fixtureModule.state.prompts[0].input
  assert.equal(sent.text, input.prompt)
  assert.ok(sent.system.startsWith(systemPrompt + '\n\n'))
  assert.ok(sent.system.includes(JSON.stringify(saved.workspaces[0].path)))
  assert.match(sent.system, /READ ONLY/)
  assert.match(sent.system, /Shell commands are disabled/)
  assert.match(sent.system, /Only claim actions confirmed by tool output/)
  assert.deepEqual(fixtureModule.state.grants, saved.workspaces)
  assert.equal(fixtureModule.state.guards, 1, 'character text must not bypass the runtime guard')
})

test('invalid character instructions fail before runtime startup or session creation', async () => {
  for (const systemPrompt of [null, 1, {}, 'invalid\0instruction', 'x'.repeat(100001)]) {
    await assert.rejects(service.start({ ...input, systemPrompt }), /Invalid system prompt/)
    assert.equal(fixtureModule.state.spawns, 0)
    assert.equal(fixtureModule.state.guards, 0)
    assert.equal(fixtureModule.state.sessions, 0)
    assert.equal(fixtureModule.state.prompts.length, 0)
    assert.equal(service.isBusy(), false)
  }
  assert.equal((await service.start({ ...input, systemPrompt:'有效的角色提示' })).running, true)
  assert.equal(fixtureModule.state.prompts.length, 1, 'a rejected input must not prevent the next valid task')
})

test('two groups sharing a folder cannot resume each other’s native sessions', async () => {
  saved = {...saved,groups:[{id:'one',name:'One',workspaceIds:['qa']},{id:'two',name:'Two',workspaceIds:['qa']}]}
  const first = await service.start({...input,groupId:'one'})
  await service.stop()
  await assert.rejects(service.start({...input,newSession:false,groupId:'two',sessionId:first.sessionId}), /another workspace group/)
  assert.equal(fixtureModule.state.prompts.length, 1)
  const fresh = await service.start({...input,groupId:'two',history:[{role:'user',content:'Kept local history'}]})
  assert.notEqual(fresh.sessionId, first.sessionId)
  assert.match(fixtureModule.state.imported[0].text, /Kept local history/)
})

const secondFolder = async (writable = false) => {
  const second = { id:'second', path:path.join(path.dirname(saved.workspaces[0].path), 'second'), name:'second', writable }
  await mkdir(second.path)
  saved = { ...saved, workspaces:[saved.workspaces[0], second] }
}
const terminalInput = change => ({ ...input, cols:100, rows:30, ...change })

test('Work tabs in different folders run side by side, and tabs in one folder share its server', async () => {
  await secondFolder()
  const first = await service.prepareTerminal(terminalInput())
  const other = await service.prepareTerminal(terminalInput({ workspaceId:'second' }))
  assert.equal(fixtureModule.state.spawns, 2, 'each folder scope gets its own guarded server')
  const sibling = await service.prepareTerminal(terminalInput())
  assert.equal(fixtureModule.state.spawns, 2, 'another tab in the same folder joins the existing server')
  assert.notEqual(sibling.remoteSessionId, first.remoteSessionId)
  assert.equal(service.terminalAttachmentAlive(first.attachment), true)
  assert.equal(service.terminalAttachmentAlive(sibling.attachment), true)
  assert.equal(service.terminalAttachmentAlive(other.attachment), true)
  await service.releaseTerminal(first.attachment)
  assert.equal(service.terminalAttachmentAlive(first.attachment), false)
  assert.equal(service.terminalAttachmentAlive(sibling.attachment), true)
  assert.equal(fixtureModule.state.kills, 0, 'a server stays while one of its tabs is open')
  await service.releaseTerminal(sibling.attachment)
  assert.equal(fixtureModule.state.kills, 1)
  assert.equal(service.isBusy(), true, 'the other folder keeps running')
  await service.releaseTerminal(other.attachment)
  assert.equal(service.terminalAttachmentAlive(other.attachment), false)
  assert.equal(fixtureModule.state.kills, 2)
  assert.equal(service.isBusy(), false)
})

test('a permission change ends only the affected tabs, which resume their sessions with the new permissions', async () => {
  await secondFolder()
  const first = await service.prepareTerminal(terminalInput())
  const other = await service.prepareTerminal(terminalInput({ workspaceId:'second' }))
  saved = { ...saved, workspaces:saved.workspaces.map(grant => grant.id === 'qa' ? { ...grant, writable:true } : grant) }
  assert.deepEqual([...await service.staleAttachments()], [first.attachment])
  assert.equal(service.terminalAttachmentAlive(first.attachment), false, 'a retired guard cannot accept a reconnect')
  assert.equal(service.terminalAttachmentAlive(other.attachment), true)
  await service.releaseTerminal(first.attachment)
  assert.equal(fixtureModule.state.kills, 1, 'the untouched folder keeps its server')
  assert.deepEqual([...await service.staleAttachments()], [], 'nothing else is outdated')
  const resumed = await service.prepareTerminal(terminalInput({ newSession:false, sessionId:first.sessionId }))
  assert.equal(resumed.remoteSessionId, first.remoteSessionId, 'read-only to editable keeps the conversation')
  assert.match(fixtureModule.state.terminalInstructions.text, /read and write/)
  assert.equal(fixtureModule.state.spawns, 3)
  saved = { ...saved, workspaces:saved.workspaces.filter(grant => grant.id !== 'second') }
  assert.deepEqual([...await service.staleAttachments()], [other.attachment], 'a removed folder ends its tabs')
  await service.releaseTerminal(other.attachment)
  await service.releaseTerminal(resumed.attachment)
})

test('closing one tab cannot stop the server another tab is joining', async () => {
  const first = await service.prepareTerminal(terminalInput())
  const selecting = deferred()
  fixtureModule.configure({ selecting })
  const joining = service.prepareTerminal(terminalInput())
  while (!fixtureModule.state.selectingStarted) await flush()
  await service.releaseTerminal(first.attachment)
  assert.equal(fixtureModule.state.kills, 0, 'the joining tab holds the shared server')
  selecting.resolve()
  const second = await joining
  assert.equal(fixtureModule.state.spawns, 1)
  await service.releaseTerminal(second.attachment)
  assert.equal(fixtureModule.state.kills, 1)
})

test('the chat view stop button leaves Work tabs alone', async () => {
  const first = await service.prepareTerminal(terminalInput())
  await service.stop()
  const second = await service.prepareTerminal(terminalInput())
  assert.equal(fixtureModule.state.spawns, 1)
  assert.equal(fixtureModule.state.kills, 0)
  await service.releaseTerminal(first.attachment)
  await service.releaseTerminal(second.attachment)
})

test('open Work tabs coexist with ordinary and workspace chat and survive chat cancellation and replacement', async () => {
  saved = { ...saved, workspaces:saved.workspaces.map(grant => ({ ...grant, writable:true })) }
  const work = await service.prepareTerminal(terminalInput())
  assert.equal(service.isBusy(), true, 'an attached tab must still prevent a runtime update')
  const plain = await service.start({ ...input, workspaceId:'' })
  assert.equal(plain.running, true)
  assert.equal(fixtureModule.state.spawns, 2)
  assert.equal(fixtureModule.state.kills, 0)
  await assert.rejects(service.start(input), /running or stopping/, 'a second chat task remains mutually exclusive')
  await service.stop()
  assert.equal(fixtureModule.state.prompts[0].signal.aborted, true)
  assert.equal(fixtureModule.state.interruptions[0], plain.sessionId.split(':').at(-1))
  assert.notEqual(fixtureModule.state.interruptions[0], work.remoteSessionId)
  assert.equal(fixtureModule.state.kills, 0, 'stopping chat must not terminate the Work server')
  assert.equal(service.isBusy(), true, 'the Work attachment continues to protect runtime updates')

  await service.start(input)
  assert.equal(fixtureModule.state.configuration.shellEffect, 'allow')
  assert.equal(fixtureModule.state.spawns, 3, 'workspace chat retains its separate automatic command policy')
  assert.equal(fixtureModule.state.kills, 1, 'only the previous plain chat server is replaced')
  await service.stop()
  const resumed = await service.prepareTerminal(terminalInput({ newSession:false, sessionId:work.sessionId }))
  assert.equal(resumed.remoteSessionId, work.remoteSessionId)
  assert.equal(fixtureModule.state.spawns, 3, 'the original Work server and session stayed available')
  assert.equal(fixtureModule.state.configuration.shellEffect, 'ask')
  await service.releaseTerminal(resumed.attachment)
  assert.equal(fixtureModule.state.kills, 1)
  await service.releaseTerminal(work.attachment)
  assert.equal(fixtureModule.state.kills, 2)
  assert.equal(service.isBusy(), false)
})

test('closing a Work tab does not cancel an ordinary chat already running beside it', async () => {
  const work = await service.prepareTerminal(terminalInput())
  await service.start({ ...input, workspaceId:'' })
  const prompt = fixtureModule.state.prompts[0]
  await service.releaseTerminal(work.attachment)
  assert.equal(fixtureModule.state.kills, 1)
  assert.equal(prompt.signal.aborted, false)
  assert.equal((await service.poll()).running, true)
  fixtureModule.configure({ messages:reply('Chat completed after Work tab closed') })
  prompt.resolve()
  await flush()
  const result = await service.poll()
  assert.equal(result.running, false)
  assert.equal(result.text, 'Chat completed after Work tab closed')
})

test('live text appears before durable projections and survives empty and delayed polls without duplication', async () => {
  await service.start(input)
  const live = fixtureModule.state.streams[0]
  live.onEvent({ type:'text', messageId:'assistant_1', ordinal:0, operation:'start', text:'' })
  live.onEvent({ type:'text', messageId:'assistant_1', ordinal:0, operation:'delta', text:'First ' })
  assert.equal((await service.poll()).text, 'First ')
  const pending = deferred()
  fixtureModule.configure({ nextMessages:pending })
  const poll = service.poll()
  live.onEvent({ type:'text', messageId:'assistant_1', ordinal:0, operation:'delta', text:'second' })
  pending.resolve(reply(''))
  assert.equal((await poll).text, 'First second')
  live.onEvent({ type:'text', messageId:'assistant_1', ordinal:0, operation:'end', text:'First second corrected' })
  assert.equal((await service.poll()).text, 'First second corrected', 'ended events reconcile missing or changed deltas')
  fixtureModule.configure({ messages:reply('First second corrected') })
  fixtureModule.state.prompts[0].resolve()
  await flush()
  const done = await service.poll()
  assert.equal(done.running, false)
  assert.equal(done.text, 'First second corrected')
  assert.equal(done.phase, undefined)
  assert.equal(fixtureModule.state.closedStreams, 1)
})

test('reasoning and tool phases remain observable while completed tool evidence survives streamed text', async () => {
  await service.start(input)
  const live = fixtureModule.state.streams[0]
  live.onEvent({ type:'phase', phase:'thinking' })
  assert.equal((await service.poll()).phase, 'thinking')
  live.onEvent({ type:'phase', phase:'tool' })
  assert.equal((await service.poll()).phase, 'tool')
  const tool = { id:'call_read', type:'tool', tool:'read', state:{ status:'completed', title:'file.txt' } }
  fixtureModule.configure({ messages:[{ info:{id:'assistant_1',role:'assistant'}, parts:[tool] }] })
  live.onEvent({ type:'text', messageId:'assistant_1', ordinal:1, operation:'delta', text:'File contents verified' })
  const state = await service.poll()
  assert.equal(state.phase, 'responding')
  assert.equal(state.text, 'File contents verified')
  assert.deepEqual(state.tools, [{ id:'call_read', name:'read', status:'completed', title:'file.txt' }])
})

test('cancelled live streams preserve partial output and cannot write into the next conversation', async () => {
  await service.start(input)
  const old = fixtureModule.state.streams[0]
  old.onEvent({ type:'text', messageId:'assistant_1', ordinal:0, operation:'delta', text:'Keep partial' })
  await service.stop()
  assert.equal((await service.poll()).text, 'Keep partial')
  assert.equal(fixtureModule.state.closedStreams, 1)
  await service.start(input)
  old.onEvent({ type:'text', messageId:'assistant_1', ordinal:0, operation:'delta', text:'Late old text' })
  assert.equal((await service.poll()).text, '')
})

test('event startup failure falls back to polling and event disconnect is corrected by the final projection', async () => {
  fixtureModule.configure({ subscriptionError:true })
  await service.start(input)
  fixtureModule.configure({ messages:reply('Polling fallback') })
  fixtureModule.state.prompts[0].resolve()
  await flush()
  assert.equal((await service.poll()).text, 'Polling fallback')
  fixtureModule.configure({ subscriptionError:false, messages:[] })
  await service.start(input)
  const live = fixtureModule.state.streams[0]
  live.onEvent({ type:'text', messageId:'assistant_1', ordinal:0, operation:'delta', text:'Partial' })
  live.onError(new Error('Disconnected'))
  fixtureModule.configure({ messages:reply('Authoritative complete answer') })
  fixtureModule.state.prompts[1].resolve()
  await flush()
  assert.equal((await service.poll()).text, 'Authoritative complete answer')
})

test('chat never auto-approves commands when a group mixes writable and read-only folders', async () => {
  await secondFolder(false)
  saved = { ...saved, workspaces:[{ ...saved.workspaces[0], writable:true }, saved.workspaces[1]], groups:[{ id:'mixed', name:'Mixed', workspaceIds:['qa','second'] }] }
  await service.start({ ...input, groupId:'mixed' })
  assert.deepEqual(fixtureModule.state.configuration, { allowShell:false, autoApproveCommands:false, shellEffect:'deny' })
  assert.match(fixtureModule.state.prompts[0].input.system, /some authorized folders are READ ONLY/)
  assert.doesNotMatch(fixtureModule.state.prompts[0].input.system, /without requesting further approval/)
  await service.stop()
  saved = { ...saved, workspaces:saved.workspaces.map(grant => ({ ...grant, writable:true })) }
  await service.start({ ...input, groupId:'mixed' })
  assert.deepEqual(fixtureModule.state.configuration, { allowShell:true, autoApproveCommands:true, shellEffect:'allow' }, 'every folder writable: commands run as in Claude Code')
  const terminal = await service.prepareTerminal(terminalInput({ groupId:'mixed' }))
  assert.equal(fixtureModule.state.configuration.shellEffect, 'ask', 'Work tabs still ask for each command')
  await service.releaseTerminal(terminal.attachment)
})

test('a starting Work tab and a chat turn do not block or cancel each other', async () => {
  const health = deferred()
  fixtureModule.configure({ health })
  const preparing = service.prepareTerminal(terminalInput())
  await flush()
  const chat = service.start({ ...input, workspaceId:'' })
  health.resolve()
  fixtureModule.configure({ health:null })
  const [terminal, started] = await Promise.all([preparing, chat])
  assert.equal(started.running, true)
  assert.equal(service.agentBusy(), true)
  await assert.rejects(service.start(input), /running or stopping/)
  const second = await service.prepareTerminal(terminalInput())
  assert.equal(fixtureModule.state.prompts[0].signal.aborted, false)
  await service.releaseTerminal(terminal.attachment)
  await service.releaseTerminal(second.attachment)
})

test('stopping during chat startup cancels it and stops its server', async () => {
  const health = deferred()
  fixtureModule.configure({ health })
  const starting = service.start(input)
  while (!fixtureModule.state.spawns) await flush()
  await service.stop()
  health.resolve()
  await assert.rejects(starting, /cancelled|exited/)
  assert.equal(fixtureModule.state.kills, 1)
  assert.equal(fixtureModule.state.prompts.length, 0)
  assert.equal(service.agentBusy(), false)
})

test('a cancellation for a tab that is not starting is not remembered', async () => {
  service.cancelPreparation('0123456789abcdef0123456789abcdef')
  const terminal = await service.prepareTerminal(terminalInput({ terminalId:'0123456789abcdef0123456789abcdef' }))
  assert.ok(terminal.attachment)
  await service.releaseTerminal(terminal.attachment)
})

test('permission replies report an ended session instead of failing on a stopped server', async () => {
  await service.start(input)
  fixtureModule.configure({ permissions:[{ id:'perm_1', sessionID:'session_1', permission:'shell', patterns:['npm test'] }] })
  assert.equal((await service.poll()).permissions.length, 1)
  await service.reply('perm_1', true)
  assert.deepEqual(fixtureModule.state.replies, [{ id:'session_1', requestId:'perm_1', allow:true }])
  await service.dispose()
  await assert.rejects(service.reply('perm_1', true), /session has ended/)
})

test('while live events arrive, polls reuse the snapshot and refresh remote state only occasionally', async () => {
  const home = path.dirname(saved.workspaces[0].path)
  service = new fixtureModule.OpenCodeService({home,get:async()=>saved},
    ()=>({proxyHost:'127.0.0.1',proxyPort:11434,enableApiKey:false,apiKeys:[]}),path.join(home,'opencode.exe'),undefined,{refreshIntervals:{messages:0,live:60000,permissions:60000}})
  await service.start(input)
  const live = fixtureModule.state.streams[0]
  const before = fixtureModule.state.messageCalls
  await service.poll()
  assert.equal(fixtureModule.state.messageCalls, before + 1, 'the first poll reconciles durable messages')
  for (let index = 0; index < 50; index++) live.onEvent({ type:'text', messageId:'assistant_1', ordinal:0, operation:'delta', text:'x' })
  const polled = await service.poll()
  assert.equal(polled.text, 'x'.repeat(50))
  assert.equal(fixtureModule.state.messageCalls, before + 1, 'live text needs no message fetch')
  assert.equal(fixtureModule.state.permissionCalls, 1)
  live.onError(new Error('Disconnected'))
  await service.poll()
  assert.equal(fixtureModule.state.messageCalls, before + 2, 'without live events polling falls back to messages')
})
