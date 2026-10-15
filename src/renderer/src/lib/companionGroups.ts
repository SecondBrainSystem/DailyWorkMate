import type { CompanionMode, CompanionSnapshot } from '../../../shared/companion'
import { createConversation, type ChatConversation } from './chatHistory.ts'

export type WorkspaceAccessScope = 'group' | 'folder'
export const normalizeRelativePath = (value: string) => value.replace(/\\/g, '/').split('/').filter(part => part && part !== '.').join('/')
export const companionScope = (mode: CompanionMode, workspaceId: string, groupId = '', accessScope: WorkspaceAccessScope = 'group', relativePath = '') => {
  if (mode === 'chat') return 'chat'
  const base = groupId ? 'agent-group:' + groupId : 'agent:' + workspaceId
  return accessScope === 'folder' && (groupId || relativePath) ? base + ':scope:' + encodeURIComponent(JSON.stringify([workspaceId, normalizeRelativePath(relativePath)])) : base
}
export function conversationLocation(scope: string) {
  const [base, details] = scope.split(':scope:')
  const groupId = base.startsWith('agent-group:') ? base.slice('agent-group:'.length) : ''
  const workspaceId = base.startsWith('agent:') ? base.slice('agent:'.length) : ''
  try {
    const tuple = details ? JSON.parse(decodeURIComponent(details)) : null
    if (Array.isArray(tuple) && tuple.length === 2 && tuple.every(item => typeof item === 'string')) return { groupId, workspaceId: tuple[0] as string, accessScope: 'folder' as const, relativePath: tuple[1] as string }
  } catch { /* Old or damaged scope metadata falls back to its authorized root. */ }
  return { groupId, workspaceId, accessScope: 'group' as const, relativePath: '' }
}
export const conversationGroup = (scope: string) => conversationLocation(scope).groupId

export function groupWorkspaces(snapshot: Pick<CompanionSnapshot, 'workspaces' | 'groups'>, groupId: string) {
  const groups = snapshot.groups || []
  const grouped = new Set(groups.flatMap(group => group.workspaceIds))
  const ids = groupId ? new Set(groups.find(group => group.id === groupId)?.workspaceIds || []) : null
  return snapshot.workspaces.filter(workspace => ids ? ids.has(workspace.id) : !grouped.has(workspace.id))
}

export function workspaceLocation(snapshot: Pick<CompanionSnapshot, 'workspaces' | 'groups'>, groupId = '', workspaceId = '') {
  const groups = snapshot.groups || []
  let group = groups.some(item => item.id === groupId) ? groupId : ''
  let members = groupWorkspaces(snapshot, group)
  if (!members.length && !group) {
    group = groups.find(item => item.workspaceIds.some(id => snapshot.workspaces.some(folder => folder.id === id)))?.id || ''
    members = groupWorkspaces(snapshot, group)
  }
  return { groupId: group, workspaceId: members.find(item => item.id === workspaceId)?.id || members[0]?.id || '', members }
}

/** Preserve visible history, but never reuse a remote session across cwd or grant changes. */
export function prepareWorkConversation(entry: ChatConversation, snapshot: Pick<CompanionSnapshot, 'workspaces' | 'groups'>, preferredWorkspace?: string, requestedGroup?: string, requestedAccess?: WorkspaceAccessScope, requestedPath?: string) {
  const stored = conversationLocation(entry.promptId)
  const groupId = requestedGroup ?? stored.groupId
  const wantedWorkspace = preferredWorkspace ?? entry.agentWorkspaceId ?? stored.workspaceId
  const location = workspaceLocation(snapshot, groupId, wantedWorkspace)
  const workspaceChanged = !!wantedWorkspace && wantedWorkspace !== location.workspaceId
  const accessScope = workspaceChanged ? 'group' : requestedAccess ?? entry.agentAccessScope ?? stored.accessScope
  const relativePath = accessScope === 'folder' ? normalizeRelativePath(requestedPath ?? entry.agentRelativePath ?? stored.relativePath) : ''
  const scope = companionScope('agent', location.workspaceId, location.groupId, accessScope, relativePath)
  const memberIds = (location.groupId ? location.members.map(item => item.id) : location.workspaceId ? [location.workspaceId] : []).sort()
  const previousMembers = entry.agentWorkspaceIds ? [...entry.agentWorkspaceIds].sort() : undefined
  const access = JSON.stringify(location.members.filter(folder => location.groupId || folder.id === location.workspaceId).map(folder => [folder.id, folder.path, folder.writable]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
  const copied = entry.promptId !== scope
  const reset = copied || (!!entry.agentWorkspaceId && entry.agentWorkspaceId !== location.workspaceId)
    || (!!entry.agentSessionId && (entry.agentAccessScope ?? stored.accessScope) !== accessScope)
    || (!!entry.agentSessionId && normalizeRelativePath(entry.agentRelativePath ?? stored.relativePath) !== relativePath)
    || (!!previousMembers && JSON.stringify(previousMembers) !== JSON.stringify(memberIds))
    || (!!location.groupId && !!entry.agentSessionId && !previousMembers)
    || (!!entry.agentSessionId && !/^v2:s[0-9a-f]{16}:/.test(entry.agentSessionId))
    || (!!entry.agentSessionId && entry.agentWorkspaceAccess !== access)
  const next = createConversation({ ...entry, promptId: scope, agentWorkspaceId: location.workspaceId, agentWorkspaceIds: memberIds, agentAccessScope: accessScope, agentRelativePath: relativePath, agentWorkspaceAccess: access,
    ...(reset ? { agentSessionId: '' } : {}), ...(copied ? { conversationId: undefined, createdAt: undefined } : {}) })
  return { ...location, accessScope, relativePath, entry: next, reset, copied }
}
