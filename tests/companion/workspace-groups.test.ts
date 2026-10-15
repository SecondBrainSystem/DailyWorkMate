import test from 'node:test'
import assert from 'node:assert/strict'
import { groupWorkspaces, validateWorkspaceGroup, workspaceAccess, workspaceRemoteSession, workspaceSessionPrefix } from '../../src/main/companion/workspaceGroups.ts'
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DEFAULT_COMPANION_SETTINGS, validateSettings } from '../../src/shared/companion.ts'

const grants = [
  { id: 'a', path: 'C:/a', name: 'a', writable: false },
  { id: 'b', path: 'C:/b', name: 'b', writable: true },
  { id: 'private', path: 'C:/private', name: 'private', writable: false },
]
const group = { id: 'research', name: 'Research', workspaceIds: ['a', 'b'] }

test('group grants include only member folders; ungrouped tasks authorize only the selected folder', () => {
  assert.deepEqual(groupWorkspaces(grants, [group], 'a', group.id).grants, grants.slice(0, 2))
  assert.deepEqual(groupWorkspaces(grants, [group], 'b').grants, [grants[1]])
  assert.throws(() => groupWorkspaces(grants, [group], 'private', group.id), /does not belong/)
  assert.throws(() => groupWorkspaces(grants, [group], 'a', 'deleted'), /does not belong/)
  assert.throws(() => groupWorkspaces(grants, [group], 'revoked'), /not authorized/)
})

test('group edits require existing grants and produce an independent deduplicated value', () => {
  const input = { name: '  Research  ', workspaceIds: ['a', 'a', 'b'] }
  assert.deepEqual(validateWorkspaceGroup(input, grants, 'research'), group)
  assert.deepEqual(input.workspaceIds, ['a', 'a', 'b'])
  assert.throws(() => validateWorkspaceGroup({ name: 'x', workspaceIds: ['missing'] }, grants, 'x'), /unauthorized/)
  assert.throws(() => validateWorkspaceGroup({ name: ' ', workspaceIds: [] }, grants, 'x'), /group name/)
})

test('native sessions stay in their group across membership changes and cannot cross groups', () => {
  const publicId = workspaceSessionPrefix(group) + 'ses_123'
  assert.equal(workspaceRemoteSession(publicId, { ...group, workspaceIds: ['b', 'a'] }), 'ses_123')
  assert.equal(workspaceRemoteSession('v2:ses_123'), 'ses_123')
  assert.equal(workspaceRemoteSession('legacy_123', group), '')
  assert.throws(() => workspaceRemoteSession(publicId, { ...group, id: 'other' }), /another workspace group/)
  assert.equal(workspaceRemoteSession(publicId, { ...group, workspaceIds: ['a'] }), 'ses_123')
  assert.throws(() => workspaceRemoteSession(publicId), /another workspace group/)
  assert.throws(() => workspaceRemoteSession('v2:ses_123', group), /another workspace group/)
})

test('old avatar settings migrate without changing speech or custom image preferences', () => {
  const { avatarVisible, avatarMode, avatarModel, ...legacy } = DEFAULT_COMPANION_SETTINGS
  const migrated = validateSettings({ ...legacy, avatar: 'avatar.png', speechRate: 1.5 } as typeof DEFAULT_COMPANION_SETTINGS)
  assert.equal(migrated.avatarVisible, true)
  assert.equal(migrated.avatarMode, '2d')
  assert.equal(migrated.avatarModel, '')
  assert.equal(migrated.avatar, 'avatar.png')
  assert.equal(migrated.speechRate, 1.5)
  assert.throws(() => validateSettings({ ...migrated, avatarMode: 'invalid' as '2d' }), /avatar display/)
})

test('folder and subfolder scopes keep nested restrictions while excluding other group members', async () => {
  await mkdir(path.resolve('tmp/qa'), { recursive: true })
  const root = await mkdtemp(path.resolve('tmp/qa/group-scope-'))
  for (const directory of ['project/docs/locked', 'other']) await mkdir(path.join(root, directory), { recursive: true })
  const local = await Promise.all([['project', true], ['other', false], ['project/docs/locked', false]].map(async ([name, writable], index) => ({ id: String(index), name: String(name), path: await realpath(path.join(root, String(name))), writable: Boolean(writable) })))
  const localGroup = { id: 'group', name: 'Group', workspaceIds: local.map(item => item.id) }
  const all = await workspaceAccess(local, [localGroup], { workspaceId: '0', groupId: 'group' })
  assert.deepEqual(all.grants, local)
  const narrow = await workspaceAccess(local, [localGroup], { workspaceId: '0', groupId: 'group', accessScope: 'folder', relativePath: 'docs' })
  assert.equal(narrow.selected.path, path.join(local[0].path, 'docs'))
  assert.deepEqual(narrow.grants.map(item => [item.path, item.writable]), [[narrow.selected.path, true], [local[2].path, false]])
  const locked = await workspaceAccess(local, [localGroup], { workspaceId: '0', groupId: 'group', accessScope: 'folder', relativePath: 'docs/locked' })
  assert.equal(locked.selected.writable, false)
  assert.equal(locked.grants.length, 1)
  const rootOnly = await workspaceAccess(local, [localGroup], { workspaceId: '0', groupId: 'group', accessScope: 'folder' })
  assert.deepEqual(rootOnly.grants.map(item => item.id), ['0', '2'])
  const publicId = workspaceSessionPrefix(localGroup, all.sessionScope) + 'ses_123'
  assert.throws(() => workspaceRemoteSession(publicId, localGroup, narrow.sessionScope), /folder scope/)
  assert.throws(() => workspaceRemoteSession(publicId, localGroup, rootOnly.sessionScope), /folder scope/)
  assert.equal(workspaceRemoteSession(publicId, localGroup, all.sessionScope), 'ses_123')
  await writeFile(path.join(local[0].path, 'file.txt'), 'not a folder')
  await assert.rejects(workspaceAccess(local, [localGroup], { workspaceId: '0', groupId: 'group', accessScope: 'folder', relativePath: '../other' }), /inside the authorized/)
  await assert.rejects(workspaceAccess(local, [localGroup], { workspaceId: '0', groupId: 'group', accessScope: 'folder', relativePath: 'file.txt' }), /directory/)
  await assert.rejects(workspaceAccess(local, [localGroup], { workspaceId: '0', groupId: 'group', relativePath: 'docs' }), /explicit folder/)
  await symlink(local[1].path, path.join(local[0].path, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(workspaceAccess(local, [localGroup], { workspaceId: '0', groupId: 'group', accessScope: 'folder', relativePath: 'escape' }), /outside/)
})

test('switching a folder between read-only and editable keeps its sessions, including ones from before that rule', async () => {
  await mkdir(path.resolve('tmp/qa'), { recursive: true })
  const root = await realpath(await mkdtemp(path.resolve('tmp/qa/permission-scope-')))
  const readOnly = [{ id: 'f', name: 'f', path: root, writable: false }]
  const editable = [{ ...readOnly[0], writable: true }]
  const before = await workspaceAccess(readOnly, [], { workspaceId: 'f' })
  const after = await workspaceAccess(editable, [], { workspaceId: 'f' })
  assert.equal(after.sessionScope, before.sessionScope)
  assert.notEqual(after.legacySessionScope, before.legacySessionScope)
  assert.equal(workspaceRemoteSession(workspaceSessionPrefix(undefined, before.sessionScope) + 'ses_new', undefined, after.sessionScope, after.legacySessionScope), 'ses_new')
  // A session saved under the old rule resumes while its permissions are unchanged.
  assert.equal(workspaceRemoteSession(workspaceSessionPrefix(undefined, before.legacySessionScope) + 'ses_old', undefined, before.sessionScope, before.legacySessionScope), 'ses_old')
  // Narrowing to a subfolder is still a different scope.
  await mkdir(path.join(root, 'docs'))
  const narrow = await workspaceAccess(editable, [], { workspaceId: 'f', accessScope: 'folder', relativePath: 'docs' })
  assert.throws(() => workspaceRemoteSession(workspaceSessionPrefix(undefined, after.sessionScope) + 'ses_new', undefined, narrow.sessionScope, narrow.legacySessionScope), /folder scope/)
})
