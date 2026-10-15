import test from 'node:test'
import assert from 'node:assert/strict'
import {
  canOfferToolRecovery,
  createToolRecoveryCandidate,
  createToolRecoveryRetryInput,
  isKnownToolRefusal,
  type ToolRecoveryCandidate,
  type ToolRecoveryObservation,
  type ToolRecoveryRetryContext,
} from '../../src/renderer/src/lib/companionToolRecovery.ts'
import { chatWorkspaceIdentity, workspaceSelectionFromState } from '../../src/renderer/src/lib/workspaceAgent.ts'

const refusal = "I can't make that tool call. I can help with a weather lookup or a read-only database connectivity check."
const observation: ToolRecoveryObservation = { text: refusal, error: '', aborted: false, running: false, toolCount: 0, permissionCount: 0 }
const workspace = { workspaceId: 'tasks', groupId: 'group', accessScope: 'group' as const, relativePath: '' }
const snapshot = {
  workspaces: [
    { id: 'tasks', name: 'Tasks', path: 'C:/qa/tasks', writable: false },
    { id: 'docs', name: 'Docs', path: 'C:/qa/docs', writable: true },
  ],
  groups: [{ id: 'group', name: 'Task project', workspaceIds: ['tasks', 'docs'] }],
}
const metadata: ToolRecoveryCandidate = {
  conversationId: 'conversation', userId: 'question', answerId: 'refused-answer', sourceModel: 'primary',
  prompt: 'Read tasks.json and return the latest incomplete task.',
  history: [{ role: 'user', content: 'Earlier question' }, { role: 'assistant', content: 'Earlier answer' }],
  workspace, systemPrompt: 'Persona', workspaceAccess: chatWorkspaceIdentity(snapshot, workspace, 'primary', 'Persona'),
}
const context: ToolRecoveryRetryContext = { model: 'fallback', conversationId: 'conversation', workspace, systemPrompt: 'Persona', snapshot }

test('recovery recognizes only the complete known refusal, allowing transport whitespace', () => {
  assert.equal(isKnownToolRefusal(refusal), true)
  assert.equal(isKnownToolRefusal(' \n' + refusal.replace('. I can', '.\nI can') + '\t'), true)
  for (const text of ["I can't make that tool call.", 'I cannot read your files.', 'Here is the error: ' + refusal, '"' + refusal + '"', refusal + ' Please try again.', '```\n' + refusal + '\n```', '']) {
    assert.equal(isKnownToolRefusal(text), false, text)
  }
})

test('running, cancelled, failed, tool-active and permission-active turns cannot offer recovery', () => {
  assert.equal(canOfferToolRecovery(observation), true)
  for (const change of [{ running: true }, { aborted: true }, { error: 'Connection interrupted' }, { toolCount: 1 }, { permissionCount: 1 }, { toolCount: -1 }, { toolCount: Number.NaN }, { permissionCount: Number.NaN }]) {
    assert.equal(canOfferToolRecovery({ ...observation, ...change }), false)
    assert.equal(createToolRecoveryCandidate(metadata, { ...observation, ...change }), null)
  }
})

test('a candidate requires a connected workspace and captures history and selection independently', () => {
  assert.equal(createToolRecoveryCandidate({ ...metadata, workspace: { ...workspace, workspaceId: '' } }, observation), null)
  assert.equal(createToolRecoveryCandidate({ ...metadata, conversationId: '' }, observation), null)
  assert.equal(createToolRecoveryCandidate({ ...metadata, workspaceAccess: '' }, observation), null)
  const candidate = createToolRecoveryCandidate(metadata, observation)
  assert.ok(candidate)
  assert.deepEqual(candidate, metadata)
  assert.notEqual(candidate, metadata)
  assert.notEqual(candidate.workspace, metadata.workspace)
  assert.notEqual(candidate.history, metadata.history)
  assert.notEqual(candidate.history[0], metadata.history[0])
})

test('explicit recovery starts a fresh session with the original prompt, clean history and unchanged scope', () => {
  const candidate = createToolRecoveryCandidate(metadata, observation)!
  const result = createToolRecoveryRetryInput(candidate, context)
  assert.equal(result.model, 'fallback')
  assert.equal(result.sessionId, '')
  assert.equal(result.newSession, true)
  assert.equal(result.prompt, metadata.prompt)
  assert.equal(result.systemPrompt, metadata.systemPrompt)
  assert.deepEqual(result.history, metadata.history)
  assert.notEqual(result.history, candidate.history)
  assert.notEqual(result.history?.[0], candidate.history[0])
  assert.equal(result.history?.some(message => message.content === refusal || message.content === metadata.prompt), false)
  assert.deepEqual({ workspaceId: result.workspaceId, groupId: result.groupId, accessScope: result.accessScope, relativePath: result.relativePath }, workspace)
  assert.deepEqual(candidate, metadata)
})

test('recovery rejects an empty model or an unchanged model', () => {
  for (const model of ['', '  ', 'primary', ' primary ']) {
    assert.throws(() => createToolRecoveryRetryInput(metadata, { ...context, model }), /different model/)
  }
})

test('changing conversation, persona, workspace, group, scope or relative directory invalidates recovery', () => {
  for (const change of [
    { conversationId: 'another' }, { systemPrompt: 'Other persona' },
    ...[{ workspaceId: 'docs' }, { groupId: '' }, { accessScope: 'folder' as const }, { relativePath: 'child' }]
      .map(scope => ({ workspace: { ...workspace, ...scope } })),
  ]) {
    assert.throws(() => createToolRecoveryRetryInput(metadata, { ...context, ...change }), /conversation or workspace changed/)
  }
})

test('fresh permission, folder-path and group-membership changes invalidate recovery', () => {
  const changed = [
    { ...snapshot, workspaces: snapshot.workspaces.map(folder => folder.id === 'tasks' ? { ...folder, writable: true } : folder) },
    { ...snapshot, workspaces: snapshot.workspaces.map(folder => folder.id === 'docs' ? { ...folder, writable: false } : folder) },
    { ...snapshot, workspaces: snapshot.workspaces.map(folder => folder.id === 'tasks' ? { ...folder, path: 'C:/qa/other' } : folder) },
    { ...snapshot, groups: [{ ...snapshot.groups[0], workspaceIds: ['tasks'] }] },
  ]
  for (const fresh of changed) {
    assert.throws(() => createToolRecoveryRetryInput(metadata, { ...context, snapshot: fresh }), /permissions changed/)
  }
})

test('revoked workspace or group cannot be recovered by using the old candidate', () => {
  assert.throws(() => createToolRecoveryRetryInput(metadata, { ...context, snapshot: { ...snapshot, workspaces: [] } }), /access was removed/)
  assert.throws(() => createToolRecoveryRetryInput(metadata, { ...context, snapshot: { ...snapshot, groups: [] } }), /group changed/)
})

test('unchanged authorization survives harmless catalog reordering and folder label changes', () => {
  const fresh = { ...snapshot, workspaces: [...snapshot.workspaces].reverse().map(folder => ({ ...folder, name: 'Renamed folder' })) }
  assert.equal(createToolRecoveryRetryInput(metadata, { ...context, snapshot: fresh }).model, 'fallback')
})

test('legacy optional workspace fields normalize to the same explicit selection used for recovery', () => {
  const selection = workspaceSelectionFromState({ messages: [], model: 'primary', promptId: 'chat', vision: 'auto', thinking: 'auto', agentWorkspaceId: 'tasks' })
  assert.deepEqual(selection, { workspaceId: 'tasks', groupId: '', accessScope: 'group', relativePath: '' })
  const candidate = { ...metadata, workspace: selection, workspaceAccess: chatWorkspaceIdentity(snapshot, selection, 'primary', 'Persona') }
  const result = createToolRecoveryRetryInput(candidate, { ...context, workspace: selection })
  assert.equal(result.accessScope, 'group')
  assert.equal(result.relativePath, '')
  assert.equal(result.groupId, '')
})

test('a subfolder retry preserves its narrow scope and cannot expand to the group or folder root', () => {
  const selection = { ...workspace, accessScope: 'folder' as const, relativePath: 'daily/tasks' }
  const candidate = { ...metadata, workspace: selection, workspaceAccess: chatWorkspaceIdentity(snapshot, selection, 'primary', 'Persona') }
  const result = createToolRecoveryRetryInput(candidate, { ...context, workspace: selection })
  assert.equal(result.accessScope, 'folder')
  assert.equal(result.relativePath, 'daily/tasks')
  assert.throws(() => createToolRecoveryRetryInput(candidate, { ...context, workspace }), /conversation or workspace changed/)
  assert.throws(() => createToolRecoveryRetryInput(candidate, { ...context, workspace: { ...selection, relativePath: '' } }), /conversation or workspace changed/)
})

test('removing another authorized group member invalidates recovery even when the selected folder remains', () => {
  const fresh = { ...snapshot, workspaces: snapshot.workspaces.filter(folder => folder.id !== 'docs') }
  assert.throws(() => createToolRecoveryRetryInput(metadata, { ...context, snapshot: fresh }), /permissions changed/)
})

test('adding a folder outside the selected authorization group does not widen or invalidate recovery', () => {
  const fresh = { ...snapshot, workspaces: [...snapshot.workspaces, { id: 'unrelated', name: 'Unrelated', path: 'C:/qa/unrelated', writable: true }] }
  const result = createToolRecoveryRetryInput(metadata, { ...context, snapshot: fresh })
  assert.equal(result.workspaceId, 'tasks')
  assert.equal(result.groupId, 'group')
})
