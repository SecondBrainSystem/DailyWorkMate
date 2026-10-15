import test from 'node:test'
import assert from 'node:assert/strict'
import { companionScope, groupWorkspaces, prepareWorkConversation, workspaceLocation } from '../../src/renderer/src/lib/companionGroups.ts'
import { createConversation } from '../../src/renderer/src/lib/chatHistory.ts'

const folders = ['a', 'b', 'c'].map(id => ({ id, name: id, path: 'C:/QA/' + id, writable: false }))
const snapshot = { workspaces: folders, groups: [{ id: 'group1', name: 'Research', workspaceIds: ['a', 'b'] }] }
const original = () => createConversation({ promptId: 'agent-group:group1', model: 'qa', vision: 'auto', thinking: 'auto',
  agentWorkspaceId: 'a', agentWorkspaceIds: ['a', 'b'], agentSessionId: 'v2:s0123456789abcdef:ses_original',
  agentWorkspaceAccess: JSON.stringify(folders.slice(0, 2).map(folder => [folder.id, folder.path, folder.writable])),
  messages: [{ id: 'm', role: 'user', content: 'Keep the original conversation' }], draft: 'Keep this draft too' })

test('groups expose exactly their members while ungrouped folders retain separate legacy scopes', () => {
  assert.deepEqual(groupWorkspaces(snapshot, '').map(item => item.id), ['c'])
  assert.deepEqual(groupWorkspaces(snapshot, 'group1').map(item => item.id), ['a', 'b'])
  assert.equal(companionScope('agent', 'a', 'group1'), companionScope('agent', 'b', 'group1'))
  assert.notEqual(companionScope('agent', 'a'), companionScope('agent', 'b'))
  assert.equal(companionScope('chat', 'a', 'group1'), 'chat')
  assert.equal(workspaceLocation(snapshot, 'group1', 'c').workspaceId, 'a')
})

test('member changes preserve visible history and the conversation id but reset native execution', () => {
  const entry = original(); const saved = structuredClone(entry)
  const result = prepareWorkConversation(entry, { ...snapshot, groups: [{ ...snapshot.groups[0], workspaceIds: ['a', 'c'] }] })
  assert.equal(result.reset, true)
  assert.equal(result.entry.agentSessionId, '')
  assert.equal(result.entry.conversationId, entry.conversationId)
  assert.deepEqual(result.entry.messages, entry.messages)
  assert.equal(result.entry.draft, entry.draft)
  assert.deepEqual(result.entry.agentWorkspaceIds, ['a', 'c'])
  assert.deepEqual(entry, saved)
})

test('changing cwd keeps the group history but invalidates the native session', () => {
  const entry = original()
  const result = prepareWorkConversation(entry, snapshot, 'b')
  assert.equal(result.entry.agentWorkspaceId, 'b')
  assert.equal(result.entry.agentSessionId, '')
  assert.equal(result.entry.conversationId, entry.conversationId)
  assert.deepEqual(result.entry.messages, entry.messages)
})

test('changing an ungrouped root scope preserves text but resets its native shell policy', () => {
  const current = prepareWorkConversation(createConversation({ promptId:'agent:c', model:'qa', vision:'auto', thinking:'auto',
    messages:[{id:'keep',role:'user',content:'Preserve this history'}] }), snapshot).entry
  const active = { ...current, agentSessionId:'v2:s0123456789abcdef:ses_root' }
  const restricted = prepareWorkConversation(active, snapshot, 'c', '', 'folder', '')
  assert.equal(restricted.entry.agentSessionId, '')
  assert.equal(restricted.entry.conversationId, active.conversationId)
  assert.deepEqual(restricted.entry.messages, active.messages)
  const restored = prepareWorkConversation({ ...restricted.entry, agentSessionId:'v2:s0123456789abcdef:ses_restricted' }, snapshot, 'c', '', 'group', '')
  assert.equal(restored.entry.agentSessionId, '')
})

test('renames and membership reordering keep the valid native session', () => {
  const entry = original()
  const result = prepareWorkConversation(entry, { ...snapshot, groups: [{ ...snapshot.groups[0], name: 'Renamed', workspaceIds: ['b', 'a'] }] })
  assert.equal(result.reset, false)
  assert.equal(result.entry.agentSessionId, entry.agentSessionId)
})

test('deleting a group copies its text into a valid scope without replacing its archive', () => {
  const entry = original()
  const result = prepareWorkConversation(entry, { ...snapshot, groups: [] })
  assert.equal(result.copied, true)
  assert.notEqual(result.entry.conversationId, entry.conversationId)
  assert.equal(result.entry.promptId, 'agent:a')
  assert.equal(entry.promptId, 'agent-group:group1')
  assert.deepEqual(result.entry.messages, entry.messages)
  assert.equal(result.entry.agentSessionId, '')
})

test('removing the active folder picks a current member and does not retain remote access', () => {
  const result = prepareWorkConversation(original(), { workspaces: folders.slice(1), groups: [{ ...snapshot.groups[0], workspaceIds: ['b'] }] })
  assert.equal(result.workspaceId, 'b')
  assert.equal(result.entry.agentSessionId, '')
  assert.deepEqual(result.entry.agentWorkspaceIds, ['b'])
})

test('whole groups, explicit members and subfolders have independently restorable scopes', () => {
  const all = companionScope('agent', 'a', 'group1')
  const member = companionScope('agent', 'a', 'group1', 'folder', '')
  const child = companionScope('agent', 'a', 'group1', 'folder', 'docs/notes')
  assert.equal(new Set([all, member, child]).size, 3)
  const saved = createConversation({ ...original(), promptId: child, agentAccessScope: 'folder', agentRelativePath: 'docs/notes' })
  const restored = prepareWorkConversation(saved, snapshot)
  assert.equal(restored.entry.promptId, child)
  assert.equal(restored.relativePath, 'docs/notes')
  assert.equal(restored.accessScope, 'folder')
  assert.equal(restored.entry.agentSessionId, saved.agentSessionId)
})

test('old native session formats migrate through the visible history without deleting records', () => {
  for (const agentSessionId of ['v2:glegacy:ses_original', 'v2:ses_original']) {
    const saved = { ...original(), agentSessionId }
    const restored = prepareWorkConversation(saved, snapshot)
    assert.equal(restored.entry.agentSessionId, '')
    assert.equal(restored.entry.conversationId, saved.conversationId)
    assert.deepEqual(restored.entry.messages, saved.messages)
  }
})

test('editing per-folder permission keeps visible history and discards the old remote grant scope', () => {
  const entry = original()
  const restored = prepareWorkConversation(entry, { ...snapshot, workspaces: folders.map(folder => folder.id === 'b' ? { ...folder, writable: true } : folder) })
  assert.equal(restored.entry.agentSessionId, '')
  assert.deepEqual(restored.entry.messages, entry.messages)
  assert.equal(restored.entry.conversationId, entry.conversationId)
})
