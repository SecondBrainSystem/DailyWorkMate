import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AgentEngine, CompanionSnapshot } from '../../../shared/companion'
import type { ChatConversation } from './chatHistory.ts'
import { conversationLocation, groupWorkspaces, normalizeRelativePath, type WorkspaceAccessScope } from './companionGroups.ts'

/** Where a Work session runs. It is fixed for the session: another folder is another session. */
export interface WorkScope { workspaceId: string; groupId: string; accessScope: WorkspaceAccessScope; relativePath: string }
export interface WorkSession extends WorkScope {
  title?: string
  id: string
  model: string
  /** Absent for OpenCode v2 sessions saved before Claude Code was offered. */
  engine?: AgentEngine
  /** Native OpenCode or Claude Code session; empty until the first connection creates it. */
  sessionId: string
  createdAt: number
  usedAt: number
  /** An old Work conversation whose text history seeds this session's first connection. */
  importFrom?: string
}
export interface WorkSessionsState {
  open: WorkSession[]
  activeId: string
  /** Closed sessions that can be reopened, newest first. */
  recent: WorkSession[]
  /** Model and scope offered for the next new session. */
  model: string
  lastScope?: WorkScope
}

const STORAGE_KEY = 'dailyworkmate.companion.workSessions.v2'
const LEGACY_TABS_KEY = 'dailyworkmate.companion.workTabs.v1'
export const MAX_OPEN_WORK_SESSIONS = 8
const MAX_RECENT = 30

const text = (value: unknown, limit: number) => typeof value === 'string' && value.length <= limit ? value : undefined
function readScope(value: unknown): WorkScope | undefined {
  if (!value || typeof value !== 'object') return undefined
  const item = value as Record<string, unknown>
  const workspaceId = text(item.workspaceId, 80), groupId = text(item.groupId, 80) ?? '', relativePath = text(item.relativePath, 4096) ?? ''
  const accessScope = item.accessScope === 'folder' ? 'folder' : item.accessScope === 'group' ? 'group' : undefined
  if (!workspaceId || !accessScope) return undefined
  return { workspaceId, groupId, accessScope, relativePath: accessScope === 'folder' ? normalizeRelativePath(relativePath) : '' }
}
function readSession(value: unknown): WorkSession | undefined {
  const scope = readScope(value)
  if (!scope) return undefined
  const item = value as Record<string, unknown>
  const id = text(item.id, 80), model = text(item.model, 300) ?? '', sessionId = text(item.sessionId, 140) ?? ''
  if (!id || !Number.isFinite(item.createdAt) || !Number.isFinite(item.usedAt)) return undefined
  const importFrom = text(item.importFrom, 80)
  return { ...scope, id, model, sessionId, ...(item.engine === 'claude' ? { engine: 'claude' as const } : {}), ...(text(item.title, 120) ? { title: text(item.title, 120) } : {}), createdAt: Number(item.createdAt), usedAt: Number(item.usedAt), ...(importFrom ? { importFrom } : {}) }
}
function readState(value: unknown): WorkSessionsState | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  const list = (entries: unknown, limit: number) => Array.isArray(entries) ? entries.map(readSession).filter((entry): entry is WorkSession => !!entry).slice(0, limit) : []
  const open = list(item.open, MAX_OPEN_WORK_SESSIONS)
  const activeId = open.some(session => session.id === item.activeId) ? item.activeId as string : open[0]?.id || ''
  return { open, activeId, recent: list(item.recent, MAX_RECENT), model: text(item.model, 300) ?? '', lastScope: readScope(item.lastScope) }
}
function loadState(): WorkSessionsState | null {
  try { return readState(JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')) }
  catch { return null }
}
function saveState(state: WorkSessionsState) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)) }
  catch (error) { console.error('[Companion] Save work sessions:', error) }
}

export const sameScope = (a: WorkScope, b: WorkScope) => a.workspaceId === b.workspaceId && a.groupId === b.groupId && a.accessScope === b.accessScope && a.relativePath === b.relativePath
const remember = (session: WorkSession, recent: WorkSession[]) => [session, ...recent.filter(item => item.id !== session.id && (!session.sessionId || item.sessionId !== session.sessionId))].slice(0, MAX_RECENT)

/**
 * Bring sessions from the previous Work design along: each old Work conversation and each
 * remembered extra tab becomes a reopenable session; the most recent one opens.
 */
export function migrateWorkSessions(conversations: ChatConversation[], fallbackModel: string, legacyTabs = readLegacyTabs(), now = Date.now()): WorkSessionsState {
  const sessions: WorkSession[] = []
  for (const entry of conversations) {
    if (!entry.promptId.startsWith('agent')) continue
    const location = conversationLocation(entry.promptId)
    const sessionId = entry.agentSessionId?.startsWith('v2:') && !/^v2:ses_/.test(entry.agentSessionId) ? entry.agentSessionId : ''
    const importFrom = !sessionId && entry.messages.some(message => message.content.trim()) ? entry.conversationId : undefined
    const workspaceId = entry.agentWorkspaceId || location.workspaceId
    if (!workspaceId || (!sessionId && !importFrom)) continue
    const accessScope = entry.agentAccessScope ?? location.accessScope
    sessions.push({ id: crypto.randomUUID(), workspaceId, groupId: location.groupId, accessScope,
      relativePath: accessScope === 'folder' ? normalizeRelativePath(entry.agentRelativePath ?? location.relativePath) : '',
      model: entry.model || fallbackModel, sessionId, createdAt: entry.createdAt, usedAt: entry.savedAt, ...(importFrom ? { importFrom } : {}) })
  }
  for (const [scope, tabs] of Object.entries(legacyTabs)) {
    const location = conversationLocation(scope)
    if (!location.workspaceId && location.groupId) {
      const owner = conversations.find(entry => entry.promptId === scope && entry.agentWorkspaceId)
      location.workspaceId = owner?.agentWorkspaceId || ''
    }
    if (!location.workspaceId) continue
    // Extra tabs kept no timestamp; list them just after their scope's own conversation.
    const owner = conversations.find(entry => entry.promptId === scope)
    for (const tab of tabs) if (tab.sessionId) sessions.push({ ...location, id: crypto.randomUUID(), model: owner?.model || fallbackModel, sessionId: tab.sessionId, createdAt: owner?.createdAt ?? now, usedAt: (owner?.savedAt ?? 1) - 1 })
  }
  const ordered = sessions.sort((a, b) => b.usedAt - a.usedAt).filter((session, index, all) => !session.sessionId || all.findIndex(other => other.sessionId === session.sessionId) === index)
  const [latest, ...rest] = ordered
  return { open: latest ? [latest] : [], activeId: latest?.id || '', recent: rest.slice(0, MAX_RECENT), model: latest?.model || fallbackModel, lastScope: latest && { workspaceId: latest.workspaceId, groupId: latest.groupId, accessScope: latest.accessScope, relativePath: latest.relativePath } }
}
function readLegacyTabs(): Record<string, Array<{ sessionId: string }>> {
  try {
    const saved = JSON.parse(localStorage.getItem(LEGACY_TABS_KEY) || '{}') as Record<string, unknown>
    return Object.fromEntries(Object.entries(saved).filter(([, tabs]) => Array.isArray(tabs)).map(([scope, tabs]) => [scope,
      (tabs as unknown[]).filter((tab): tab is { sessionId: string } => typeof (tab as { sessionId?: unknown })?.sessionId === 'string')]))
  } catch { return {} }
}

export type WorkAccess = 'edit' | 'read' | 'mixed'
export interface WorkScopeInfo {
  /** Folder or group name, with the subfolder when narrowed. */
  name: string
  paths: string[]
  access: WorkAccess
  /** Shell commands: asked for approval, or unavailable in read-only and narrowed scopes. */
  commands: boolean
  /** The folder (or group) is no longer authorized; the session cannot reconnect. */
  missing: boolean
}
/** Mirrors the main process: what a session in this scope may read, edit and run. */
export function describeWorkScope(snapshot: Pick<CompanionSnapshot, 'workspaces' | 'groups'> | null, scope: WorkScope): WorkScopeInfo {
  const folder = snapshot?.workspaces.find(item => item.id === scope.workspaceId)
  if (scope.groupId && scope.accessScope === 'group') {
    const group = snapshot?.groups.find(item => item.id === scope.groupId)
    const members = snapshot && group ? groupWorkspaces(snapshot, group.id) : []
    const writable = members.filter(item => item.writable).length
    return { name: group?.name || scope.groupId, paths: members.map(item => item.path), access: writable === members.length && writable ? 'edit' : writable ? 'mixed' : 'read',
      commands: !!folder?.writable, missing: !group || !folder || !members.some(item => item.id === folder.id) }
  }
  const sub = scope.accessScope === 'folder' ? normalizeRelativePath(scope.relativePath) : ''
  return { name: (folder?.name || scope.workspaceId) + (sub ? ' / ' + sub : ''), paths: folder ? [folder.path + (sub ? '/' + sub : '')] : [],
    access: folder?.writable ? 'edit' : 'read', commands: !!folder?.writable && scope.accessScope !== 'folder',
    missing: !folder || (!!scope.groupId && !snapshot?.groups.some(group => group.id === scope.groupId && group.workspaceIds.includes(folder.id))) }
}

/**
 * Open Work tabs, closed sessions to reopen, and the defaults for the next one. Persisted per device.
 * The first run migrates old Work conversations once `ready` (their settings are loaded).
 */
export function useWorkSessions(fallbackModel: string, loadLegacy: () => Promise<ChatConversation[]>, ready = true) {
  const [state, setState] = useState<WorkSessionsState | null>(loadState)
  useEffect(() => {
    if (state || !ready) return
    let cancelled = false
    void loadLegacy().catch(error => { console.error('[Companion] Read old work conversations:', error); return [] })
      .then(conversations => { if (!cancelled) setState(current => current || migrateWorkSessions(conversations, fallbackModel)) })
    return () => { cancelled = true }
  }, [ready])
  useEffect(() => { if (state) saveState(state) }, [state])
  const update = useCallback((change: (current: WorkSessionsState) => WorkSessionsState) => setState(current => current ? change(current) : current), [])
  const active = state?.open.find(session => session.id === state.activeId)
  const actions = useMemo(() => ({
    /** Opens a new session in `scope`; false when the tab limit is reached. */
    create(scope: WorkScope, model: string, engine: AgentEngine = 'opencode'): boolean {
      if (!state || state.open.length >= MAX_OPEN_WORK_SESSIONS) return false
      const now = Date.now()
      const session: WorkSession = { ...scope, id: crypto.randomUUID(), model, sessionId: '', createdAt: now, usedAt: now, ...(engine === 'claude' ? { engine } : {}) }
      update(current => ({ ...current, open: [...current.open, session], activeId: session.id, model, lastScope: { ...scope } }))
      return true
    },
    rename(id: string, title: string) { update(current => ({ ...current, open: current.open.map(session => session.id === id ? { ...session, title: title.trim().slice(0, 120) } : session) })) },
    activate(id: string) { update(current => current.open.some(session => session.id === id) ? { ...current, activeId: id } : current) },
    /** Closing disconnects the tab; a session that ever connected stays reopenable. */
    close(id: string) {
      update(current => {
        const index = current.open.findIndex(session => session.id === id)
        if (index < 0) return current
        const session = { ...current.open[index], usedAt: Date.now() }
        const open = current.open.filter(item => item.id !== id)
        const activeId = current.activeId === id ? (open[Math.min(index, open.length - 1)]?.id || '') : current.activeId
        return { ...current, open, activeId, recent: session.sessionId || session.importFrom ? remember(session, current.recent) : current.recent }
      })
    },
    /** Reopens a closed session (or shows it if it is already open); false when the tab limit is reached. */
    reopen(id: string): boolean {
      if (!state) return false
      const session = state.recent.find(item => item.id === id)
      if (!session) return false
      const already = state.open.find(item => !!session.sessionId && item.sessionId === session.sessionId)
      if (!already && state.open.length >= MAX_OPEN_WORK_SESSIONS) return false
      update(current => already ? { ...current, activeId: already.id, recent: current.recent.filter(item => item.id !== id) }
        : { ...current, open: [...current.open, { ...session, usedAt: Date.now() }], activeId: session.id, recent: current.recent.filter(item => item.id !== id) })
      return true
    },
    forget(id: string) { update(current => ({ ...current, recent: current.recent.filter(item => item.id !== id) })) },
    /** Records the native session once connected; the old text history is then no longer needed. */
    connected(id: string, sessionId: string) {
      update(current => ({ ...current, open: current.open.map(session => session.id === id && (session.sessionId !== sessionId || session.importFrom)
        ? { ...session, sessionId, importFrom: undefined, usedAt: Date.now() } : session) }))
    },
    /** Changes one session's model, or the default for new sessions when no session is given. */
    setModel(model: string, id?: string) {
      update(current => ({ ...current, model, open: id ? current.open.map(session => session.id === id ? { ...session, model } : session) : current.open }))
    },
  }), [state, update])
  return { ready: !!state, open: state?.open || [], recent: state?.recent || [], active, model: state?.model || fallbackModel, lastScope: state?.lastScope, ...actions }
}
export type WorkSessions = ReturnType<typeof useWorkSessions>
