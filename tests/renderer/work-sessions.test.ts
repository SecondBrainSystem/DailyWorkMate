import test from 'node:test'
import assert from 'node:assert/strict'
import { describeWorkScope, migrateWorkSessions } from '../../src/renderer/src/lib/workSessions.ts'
import { companionScope } from '../../src/renderer/src/lib/companionGroups.ts'
import { createConversation } from '../../src/renderer/src/lib/chatHistory.ts'

const folders = [{ id: 'a', name: 'Alpha', path: 'C:/QA/a', writable: true }, { id: 'b', name: 'Beta', path: 'C:/QA/b', writable: false }]
const snapshot = { workspaces: folders, groups: [{ id: 'g', name: 'Research', workspaceIds: ['a', 'b'] }] }
const work = (promptId: string, change: Record<string, unknown>, savedAt: number) => createConversation({ promptId, model: 'qa-model', vision: 'auto', thinking: 'auto', messages: [], ...change }, savedAt)

test('old Work conversations and remembered tabs become reopenable sessions; the latest one opens', () => {
  const conversations = [
    createConversation({ promptId: 'chat', model: 'qa-model', vision: 'auto', thinking: 'auto', messages: [{ id: 'c', role: 'user', content: 'chat stays in chat' }] }),
    work(companionScope('agent', 'a'), { agentWorkspaceId: 'a', agentSessionId: 'v2:s0123456789abcdef:ses_old' }, 1000),
    work(companionScope('agent', 'a', 'g'), { agentWorkspaceId: 'b', agentSessionId: 'v2:s1111111111111111:ses_group' }, 3000),
    work(companionScope('agent', 'a', '', 'folder', 'docs'), { agentWorkspaceId: 'a', agentAccessScope: 'folder', agentRelativePath: 'docs', messages: [{ id: 'v1', role: 'user', content: 'V1 text history' }] }, 2000),
    work(companionScope('agent', 'b'), { agentWorkspaceId: 'b' }, 4000),
  ]
  const legacyTabs = { [companionScope('agent', 'a')]: [{ sessionId: 'v2:s0123456789abcdef:ses_tab' }, { sessionId: 'v2:s0123456789abcdef:ses_old' }, { sessionId: '' }] }
  const state = migrateWorkSessions(conversations, 'fallback', legacyTabs, 5000)
  assert.equal(state.open.length, 1)
  assert.equal(state.open[0].sessionId, 'v2:s1111111111111111:ses_group', 'the most recently used session opens')
  assert.deepEqual({ ...state.open[0], id: '' }, { id: '', workspaceId: 'b', groupId: 'g', accessScope: 'group', relativePath: '', model: 'qa-model', sessionId: 'v2:s1111111111111111:ses_group', createdAt: state.open[0].createdAt, usedAt: 3000 })
  assert.equal(state.activeId, state.open[0].id)
  const recent = state.recent.map(session => [session.sessionId, session.workspaceId, session.accessScope, session.relativePath, !!session.importFrom])
  assert.deepEqual(recent, [
    ['', 'a', 'folder', 'docs', true],
    ['v2:s0123456789abcdef:ses_old', 'a', 'group', '', false],
    ['v2:s0123456789abcdef:ses_tab', 'a', 'group', '', false],
  ], 'empty conversations are skipped, text-only ones import their history, extra tabs follow their scope, duplicates collapse')
  assert.equal(state.recent[2].model, 'qa-model', 'an extra tab takes its scope conversation’s model')
  assert.equal(state.model, 'qa-model')
  assert.deepEqual(state.lastScope, { workspaceId: 'b', groupId: 'g', accessScope: 'group', relativePath: '' })
  assert.deepEqual(migrateWorkSessions([], 'fallback', {}), { open: [], activeId: '', recent: [], model: 'fallback', lastScope: undefined })
})

test('a scope description mirrors the main process permissions and notices removed folders', () => {
  assert.deepEqual(describeWorkScope(snapshot, { workspaceId: 'a', groupId: '', accessScope: 'group', relativePath: '' }),
    { name: 'Alpha', paths: ['C:/QA/a'], access: 'edit', commands: true, missing: false })
  assert.deepEqual(describeWorkScope(snapshot, { workspaceId: 'a', groupId: '', accessScope: 'folder', relativePath: 'docs/' }),
    { name: 'Alpha / docs', paths: ['C:/QA/a/docs'], access: 'edit', commands: false, missing: false }, 'a narrowed scope cannot run commands')
  assert.deepEqual(describeWorkScope(snapshot, { workspaceId: 'b', groupId: '', accessScope: 'group', relativePath: '' }),
    { name: 'Beta', paths: ['C:/QA/b'], access: 'read', commands: false, missing: false })
  assert.deepEqual(describeWorkScope(snapshot, { workspaceId: 'b', groupId: 'g', accessScope: 'group', relativePath: '' }),
    { name: 'Research', paths: ['C:/QA/a', 'C:/QA/b'], access: 'mixed', commands: false, missing: false }, 'commands follow the starting folder')
  assert.equal(describeWorkScope(snapshot, { workspaceId: 'gone', groupId: '', accessScope: 'group', relativePath: '' }).missing, true)
  assert.equal(describeWorkScope({ ...snapshot, groups: [] }, { workspaceId: 'a', groupId: 'g', accessScope: 'group', relativePath: '' }).missing, true)
  assert.equal(describeWorkScope({ ...snapshot, groups: [{ id: 'g', name: 'Research', workspaceIds: ['b'] }] }, { workspaceId: 'a', groupId: 'g', accessScope: 'group', relativePath: '' }).missing, true, 'a folder that left its group')
})
