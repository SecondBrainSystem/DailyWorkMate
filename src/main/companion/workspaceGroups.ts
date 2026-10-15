import { boundedText, type WorkspaceGrant, type WorkspaceGroup, type WorkspaceGroupInput } from '../../shared/companion.ts'
import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { isWithin, resolveWorkspacePath } from './workspaces.ts'

export function validateWorkspaceGroup(input: WorkspaceGroupInput, workspaces: WorkspaceGrant[], id: string): WorkspaceGroup {
  if (!input || typeof input !== 'object') throw new Error('Invalid workspace group')
  const name = boundedText(input.name, 'group name', 80, true).trim()
  if (!Array.isArray(input.workspaceIds) || input.workspaceIds.length > 32) throw new Error('Invalid group folders')
  const ids = [...new Set(input.workspaceIds.map(value => boundedText(value, 'workspace ID', 80, true)))]
  if (ids.some(value => !workspaces.some(grant => grant.id === value))) throw new Error('分组包含未授权的文件夹。 / Group contains an unauthorized folder.')
  return { id: boundedText(id, 'group ID', 80, true), name, workspaceIds: ids }
}

export function groupWorkspaces(workspaces: WorkspaceGrant[], groups: WorkspaceGroup[], workspaceId: string, groupId?: string) {
  boundedText(workspaceId, 'workspace ID', 80, true)
  const selected = workspaces.find(grant => grant.id === workspaceId)
  if (!selected) throw new Error('This folder is not authorized')
  if (!groupId) return { selected, grants: [selected], group: undefined }
  boundedText(groupId, 'group ID', 80, true)
  const group = groups.find(item => item.id === groupId)
  if (!group || !group.workspaceIds.includes(workspaceId)) throw new Error('当前文件夹不属于这个分组。 / This folder does not belong to the selected group.')
  return { selected, grants: workspaces.filter(grant => group.workspaceIds.includes(grant.id)), group }
}

/** Narrow the actual tool grants, including more-specific permissions inside the selected directory. */
export async function workspaceAccess(workspaces: WorkspaceGrant[], groups: WorkspaceGroup[], input: {
  workspaceId: string; groupId?: string; accessScope?: 'group' | 'folder'; relativePath?: string
}) {
  const base = groupWorkspaces(workspaces, groups, input.workspaceId, input.groupId)
  const accessScope = input.accessScope ?? 'group'
  if (!['group', 'folder'].includes(accessScope)) throw new Error('Invalid workspace access scope')
  const relativePath = boundedText(input.relativePath ?? '', 'workspace subfolder', 4096)
  if (accessScope === 'group' && relativePath) throw new Error('A subfolder requires an explicit folder scope')
  const directory = await resolveWorkspacePath(base.selected, accessScope === 'folder' ? relativePath : '')
  if (!(await stat(directory)).isDirectory()) throw new Error('请选择文件夹作为工作范围。 / Select a directory as the workspace scope.')
  const inherited = [...base.grants].filter(grant => isWithin(grant.path, directory)).sort((a, b) => b.path.length - a.path.length)[0] || base.selected
  const selected = { ...base.selected, path: directory, writable: inherited.writable }
  const grants = accessScope === 'group' ? base.grants : [selected, ...base.grants.filter(grant =>
    path.relative(grant.path, directory) !== '' && isWithin(directory, grant.path))]
  const scope = (fields: (grant: WorkspaceGrant) => unknown[]) => JSON.stringify([base.group?.id || '', base.selected.id, accessScope, directory,
    grants.map(fields).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))])
  // Switching a folder between read-only and editable keeps its sessions: the guard and
  // instructions always apply the current permissions. Other scope changes start over.
  const sessionScope = JSON.stringify([base.group?.id || '', base.selected.id, accessScope, directory])
  // Sessions created before that rule included each permission in their scope.
  const legacySessionScope = scope(grant => [grant.id, grant.path, grant.writable])
  const previousSessionScope = scope(grant => [grant.id, grant.path])
  return { selected, grants, group: base.group, sessionScope, legacySessionScope, previousSessionScope }
}

/** A shared directory must not allow one named group's native session into another. */
export function workspaceSessionPrefix(group?: WorkspaceGroup, sessionScope?: string): string {
  if (sessionScope) return 'v2:s' + createHash('sha256').update(sessionScope).digest('hex').slice(0, 16) + ':'
  if (!group) return 'v2:'
  const scope = JSON.stringify([group.id])
  return 'v2:g' + createHash('sha256').update(scope).digest('hex').slice(0, 16) + ':'
}

export function workspaceRemoteSession(publicId: string, group?: WorkspaceGroup, sessionScope?: string, legacySessionScope?: string, previousSessionScope?: string): string {
  if (!publicId.startsWith('v2:')) return ''
  const prefix = [workspaceSessionPrefix(group, sessionScope), ...(legacySessionScope ? [workspaceSessionPrefix(group, legacySessionScope)] : []), ...(previousSessionScope ? [workspaceSessionPrefix(group, previousSessionScope)] : [])]
    .find(candidate => publicId.startsWith(candidate))
  const remote = prefix ? publicId.slice(prefix.length) : ''
  if (!remote || remote.includes(':')) throw new Error('此会话的工作范围已变化。请新建会话。 / This session belongs to another workspace group or folder scope. Start a new conversation.')
  return boundedText(remote, 'OpenCode session', 100, true)
}
