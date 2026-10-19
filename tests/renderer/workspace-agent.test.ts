import test, { before } from 'node:test'
import assert from 'node:assert/strict'
import { WorkspaceAgentRunner, chatWorkspaceIdentity, workspaceSelectionFromState, workspaceStateFields } from '../../src/renderer/src/lib/workspaceAgent.ts'
import { normalizeChatWorkspace } from '../../src/renderer/src/lib/chatWorkspace.ts'
import type { AgentInput, AgentSnapshot, CompanionAPI } from '../../src/shared/companion.ts'
import { i18nReady } from './i18nSetup.ts'

before(() => i18nReady)

const input: AgentInput = { workspaceId: 'folder', model: 'model-a', prompt: 'Read README.md' }
const state = (extra: Partial<AgentSnapshot> = {}): AgentSnapshot => ({ sessionId: 'v2:s123:session', running: false, text: 'Done', error: '', tools: [], permissions: [], ...extra })
type API = Pick<CompanionAPI, 'startAgent' | 'pollAgent' | 'stopAgent' | 'replyPermission'>
const api = (extra: Partial<API> = {}): API => ({ startAgent: async () => state(), pollAgent: async () => state(), stopAgent: async () => {}, replyPermission: async () => {}, ...extra })

test('workspace conversation metadata preserves its group, scope and grant identity', () => {
  const selection = { workspaceId: 'folder', groupId: 'group', accessScope: 'folder' as const, relativePath: 'src' }
  const restored = normalizeChatWorkspace({ ...workspaceStateFields(selection), agentSessionId: 'session', agentWorkspaceAccess: 'identity' })
  assert.deepEqual(workspaceSelectionFromState(restored), selection)
  assert.equal(restored.agentSessionId, 'session')
  assert.equal(restored.agentWorkspaceAccess, 'identity')
})

test('model, persona, permissions and group membership invalidate a restored workspace session', () => {
  const snapshot = { workspaces: [{ id: 'folder', name: 'Project', path: 'C:/project', writable: true }, { id: 'other', name: 'Docs', path: 'C:/docs', writable: false }], groups: [{ id: 'group', name: 'Both', workspaceIds: ['folder', 'other'] }] }
  const selection = { workspaceId: 'folder', groupId: 'group', accessScope: 'group' as const, relativePath: '' }
  const identity = chatWorkspaceIdentity(snapshot, selection, 'model-a', 'persona')
  assert.notEqual(chatWorkspaceIdentity(snapshot, selection, 'model-b', 'persona'), identity)
  assert.notEqual(chatWorkspaceIdentity(snapshot, selection, 'model-a', 'changed'), identity)
  assert.notEqual(chatWorkspaceIdentity({ ...snapshot, workspaces: snapshot.workspaces.map(folder => ({ ...folder, writable: false })) }, selection, 'model-a', 'persona'), identity)
  assert.notEqual(chatWorkspaceIdentity({ ...snapshot, groups: [{ ...snapshot.groups[0], workspaceIds: ['folder'] }] }, selection, 'model-a', 'persona'), identity)
  assert.throws(() => chatWorkspaceIdentity({ ...snapshot, workspaces: [] }, selection, 'model-a'), /access was removed/)
  assert.throws(() => chatWorkspaceIdentity({ ...snapshot, groups: [] }, selection, 'model-a'), /group changed/)
})

test('new chats explicitly pass an empty session instead of inheriting another page task', async () => {
  let received: AgentInput | undefined
  const runner = new WorkspaceAgentRunner(api({ startAgent: async value => { received = value; return state() } }))
  await runner.execute(input)
  assert.equal(received?.sessionId, '')
  assert.equal(input.sessionId, undefined)
})

test('chat without a workspace retains a session only for the same model and persona', () => {
  const snapshot = { workspaces: [{ id: 'folder', name: 'Project', path: 'C:/project', writable: true }], groups: [] }
  const selection = { workspaceId: '', groupId: '', accessScope: 'group' as const, relativePath: '' }
  const identity = chatWorkspaceIdentity(snapshot, selection, 'model-a', 'persona')
  assert.ok(identity)
  assert.equal(chatWorkspaceIdentity({ workspaces: [], groups: [] }, selection, 'model-a', 'persona'), identity, 'adding a grant does not connect a chat to it')
  assert.notEqual(chatWorkspaceIdentity(snapshot, selection, 'model-b', 'persona'), identity)
  assert.notEqual(chatWorkspaceIdentity(snapshot, selection, 'model-a', 'changed'), identity)
  assert.notEqual(chatWorkspaceIdentity(snapshot, { ...selection, workspaceId: 'folder' }, 'model-a', 'persona'), identity)
  const restored = normalizeChatWorkspace({ ...workspaceStateFields(selection), agentSessionId: 'session', agentWorkspaceAccess: identity })
  assert.equal(restored.agentSessionId, 'session')
  assert.equal(restored.agentWorkspaceAccess, identity)
})

test('pending startup cancellation blocks another page until the owned session is stopped', async () => {
  let release!: (value: AgentSnapshot) => void
  let stops = 0
  const first = new WorkspaceAgentRunner(api({ startAgent: () => new Promise(resolve => { release = resolve }), pollAgent: async () => state({ running: true }), stopAgent: async () => { stops++ } }))
  const second = new WorkspaceAgentRunner(api())
  const running = first.execute(input)
  const rejected = assert.rejects(running, { name: 'AbortError' })
  const stopping = first.cancel()
  await assert.rejects(second.execute(input), /running or stopping/)
  assert.equal(stops, 1, 'a pending startup is cancelled in main without waiting for it to finish')
  release(state({ running: true }))
  await stopping
  await rejected
  assert.equal(stops, 2, 'a start that still won the race is stopped as well')
  assert.equal((await second.execute(input)).text, 'Done')
})

test('a startup cancelled in main rejects without a second stop request', async () => {
  let reject!: (error: Error) => void
  let stops = 0
  const runner = new WorkspaceAgentRunner(api({ startAgent: () => new Promise((_resolve, fail) => { reject = fail }), stopAgent: async () => { stops++; reject(new Error('Agent task cancelled')) } }))
  const running = runner.execute(input)
  await runner.cancel()
  await assert.rejects(running, { name: 'AbortError' })
  assert.equal(stops, 1)
})

test('polls that bring nothing new do not publish duplicate updates', async () => {
  let polls = 0
  const runner = new WorkspaceAgentRunner(api({ startAgent: async () => state({ running: true, text: 'Partial' }),
    pollAgent: async () => ++polls < 3 ? state({ running: true, text: 'Partial' }) : state({ text: 'Done' }) }))
  const updates: string[] = []
  await runner.execute(input, { onUpdate: snapshot => updates.push(snapshot.text + ':' + snapshot.running) })
  assert.deepEqual(updates, ['Partial:true', 'Done:false'])
})

test('cancellation never stops a different session after ownership changes in main', async () => {
  let release!: (value: AgentSnapshot) => void
  let stops = 0
  const runner = new WorkspaceAgentRunner(api({ startAgent: () => new Promise(resolve => { release = resolve }), pollAgent: async () => state({ sessionId: 'another-session', running: true }), stopAgent: async () => { stops++ } }))
  const running = runner.execute(input)
  const rejected = assert.rejects(running, { name: 'AbortError' })
  const stopping = runner.cancel()
  release(state({ running: true }))
  await stopping
  await rejected
  assert.equal(stops, 1, 'only the pending startup is cancelled, never the other session')
})

test('permission approval belongs to the active workspace session and tool results survive completion', async () => {
  let polls = 0
  let approvals = 0
  const runner = new WorkspaceAgentRunner(api({
    startAgent: async () => state({ running: true, permissions: [{ id: 'permission', sessionID: 'v2:s123:session', permission: 'shell', patterns: ['npm test'] }] }),
    pollAgent: async () => { polls++; return state({ tools: [{ id: 'read', name: 'read', status: 'completed', title: 'README.md' }] }) },
    replyPermission: async () => { approvals++ },
  }))
  const result = await runner.execute(input, { onUpdate: snapshot => { if (snapshot.permissions.length) void runner.reply('permission', true) } })
  assert.equal(result.tools[0].name, 'read')
  assert.equal(polls, 1)
  assert.equal(approvals, 1)
  await assert.rejects(runner.reply('permission', true), /no longer active/)
})

test('a failed startup releases ownership for the next page and surfaces the actual failure', async () => {
  const failed = new WorkspaceAgentRunner(api({ startAgent: async () => { throw new Error('Runtime missing') } }))
  await assert.rejects(failed.execute(input), /Runtime missing/)
  const next = new WorkspaceAgentRunner(api())
  assert.equal((await next.execute(input)).text, 'Done')
})

test('a failed poll interrupts its owned task even if refreshing the stop state also fails', async () => {
  let stops = 0
  const runner = new WorkspaceAgentRunner(api({ startAgent: async () => state({ running: true }), pollAgent: async () => { throw new Error('Connection lost') }, stopAgent: async () => { stops++ } }))
  await assert.rejects(runner.execute(input), /Connection lost/)
  assert.equal(stops, 1)
  assert.equal((await new WorkspaceAgentRunner(api()).execute(input)).text, 'Done')
})
