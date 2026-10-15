import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, Folder, FolderCog, FolderOpen, FolderPlus, History, Pencil, Layers, LoaderCircle, Plus, Terminal as TerminalIcon, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { TerminalPhase } from './OpenCodeTerminal'
// xterm loads with the first Work tab, not with the assistant page.
const OpenCodeTerminal = lazy(() => import('./OpenCodeTerminal').then(module => ({ default: module.OpenCodeTerminal })))
import type { CompanionCopy } from './copy'
import { folderLabel } from '@/lib/folderLabel'
import { describeWorkScope, MAX_OPEN_WORK_SESSIONS, type WorkAccess, type WorkScope, type WorkSession, type WorkSessions as WorkSessionsModel } from '@/lib/workSessions'
import type { AgentEngine, CompanionSnapshot, TerminalInput, WorkspaceEntry } from '@shared/companion'

type History = TerminalInput['history']
const accessText = (copy: CompanionCopy, access: WorkAccess) => access === 'edit' ? copy.accessEdit : access === 'mixed' ? copy.accessMixed : copy.accessRead
const count = (template: string, n: number) => template.replace('{n}', String(n))
const engineName = (engine?: AgentEngine) => engine === 'claude' ? 'Claude Code' : 'OpenCode'
/** Claude Code cannot limit edits per folder, so a partly editable group runs read only. */
const sessionAccess = (session: WorkSession, access: WorkAccess): WorkAccess => session.engine === 'claude' && access === 'mixed' ? 'read' : access

/**
 * Work sessions: each tab is one native OpenCode session bound to one folder scope, shown on the tab.
 * Tabs open from "New session" (or a folder in Folder access), close with ×, and closed sessions stay
 * reopenable under "Recent sessions". A tab connects the first time it is shown and then stays
 * connected (also while the Chat view is open) until it is closed.
 */
export function WorkSessions({ work, snapshot, copy, chinese, visible, screenReaderMode, prepare, loadHistory, onFolders, onAddFolder, onError, models }: {
  work: WorkSessionsModel
  models: string[]
  snapshot: CompanionSnapshot | null
  copy: CompanionCopy; chinese: boolean
  /** The Work view is showing. Hidden tabs stay connected. */
  visible: boolean
  screenReaderMode: boolean
  /** Starts the proxy and checks the model before a tab connects. */
  prepare: (model: string) => Promise<void>
  /** Text of an old Work conversation, carried into the session's first connection. */
  loadHistory: (conversationId: string) => Promise<History>
  onFolders: () => void
  onAddFolder: () => void
  onError: (message: string) => void
}) {
  const [mounted, setMounted] = useState<Set<string>>(() => new Set())
  const [phases, setPhases] = useState<Record<string, TerminalPhase>>({})
  const [histories, setHistories] = useState<Record<string, History | null>>({})
  const [creating, setCreating] = useState(false)
  const [rename, setRename] = useState<{ id: string; title: string } | null>(null)
  const [recentOpen, setRecentOpen] = useState(false)
  const active = work.active
  const strip = useRef<HTMLDivElement>(null)
  const full = work.open.length >= MAX_OPEN_WORK_SESSIONS
  const workspaces = snapshot?.workspaces || []

  // A tab connects the first time it is shown, then stays connected until closed.
  useEffect(() => {
    if (visible && active && !mounted.has(active.id)) setMounted(current => new Set(current).add(active.id))
  }, [visible, active?.id])
  useEffect(() => {
    const open = new Set(work.open.map(session => session.id))
    setMounted(current => [...current].every(id => open.has(id)) ? current : new Set([...current].filter(id => open.has(id))))
  }, [work.open])
  useEffect(() => { if (visible) strip.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }, [visible, active?.id])
  // Sessions carried over from old Work conversations import their text once.
  useEffect(() => {
    for (const session of work.open) {
      if (!mounted.has(session.id) || session.sessionId || !session.importFrom || session.id in histories) continue
      setHistories(current => ({ ...current, [session.id]: null }))
      void loadHistory(session.importFrom).catch(error => { console.error('[Companion] Read old work history:', error); return undefined })
        .then(history => setHistories(current => ({ ...current, [session.id]: history || [] })))
    }
  }, [work.open, mounted])

  const labels = useMemo(() => {
    const seen = new Map<string, number>()
    return Object.fromEntries(work.open.map(session => {
      const name = session.title || (session.accessScope === 'folder' && session.relativePath ? folderLabel(session.relativePath) : describeWorkScope(snapshot, session).name)
      const index = (seen.get(name) || 0) + 1
      seen.set(name, index)
      return [session.id, index > 1 ? name + ' ' + index : name]
    }))
  }, [work.open, snapshot])
  const openNew = () => { if (full) onError(copy.workSessionLimit); else setCreating(true) }
  const closeSession = (id: string) => {
    if (['starting', 'running'].includes(phases[id] || '') && !window.confirm(chinese ? '关闭会话会结束正在执行的任务，继续？' : 'Closing this session ends its running task. Continue?')) return
    work.close(id)
  }
  const reopen = (id: string) => { if (!work.reopen(id)) onError(copy.workSessionLimit); else setRecentOpen(false) }

  const details = (session: WorkSession) => {
    const info = describeWorkScope(snapshot, session)
    return <span className="work-session-details" title={info.paths.join('\n')}>
      {session.groupId && session.accessScope === 'group' ? <Layers size={13} /> : <Folder size={13} />}
      <span className="work-session-path">{info.paths.length > 1 ? count(copy.foldersCount, info.paths.length) : info.paths[0]}</span>
      <span className="work-chip" data-access={sessionAccess(session, info.access)}>{accessText(copy, sessionAccess(session, info.access))}</span>
      <span className="work-chip">{info.commands && sessionAccess(session, info.access) !== 'read' ? copy.commandsAsk : copy.commandsOff}</span>
      <span className="work-chip">{engineName(session.engine)}</span>
      <span className="work-session-model" title={session.model}>{session.model}</span>
    </span>
  }
  const panel = (session: WorkSession) => {
    const info = describeWorkScope(snapshot, session)
    if (!snapshot) return <div className="work-panel" role="status"><LoaderCircle size={22} className="animate-spin" /></div>
    if (session.engine === 'claude' ? !snapshot.claudeCode?.available : !snapshot.runtimeAvailable) return <div className="work-panel"><TerminalIcon size={28} /><p>{session.engine === 'claude' ? copy.claudeMissing : copy.runtimeMissing}</p></div>
    if (session.engine === 'claude' && session.model.startsWith('opencode-free/')) return <div className="work-panel"><TerminalIcon size={28} /><p>{copy.claudeModelsOnly}</p></div>
    if (info.missing) return <div className="work-panel"><FolderCog size={28} /><p>{copy.folderMissing}</p><div className="work-panel-actions">
      <Button size="sm" variant="outline" onClick={onFolders}><FolderCog size={14} className="mr-2" />{copy.folderAccess}</Button>
      <Button size="sm" variant="outline" onClick={() => closeSession(session.id)}><X size={14} className="mr-2" />{copy.closeWorkSession}</Button></div></div>
    if (!session.model) return <div className="work-panel"><TerminalIcon size={28} /><p>{chinese ? '在上方选择这个会话使用的模型后开始连接。' : 'Choose a model for this session above to connect.'}</p></div>
    return null
  }

  return <div className="work-sessions" hidden={!visible}>
    <Dialog open={!!rename} onOpenChange={open => { if (!open) setRename(null) }}><DialogContent><DialogHeader><DialogTitle>{chinese ? '会话标题' : 'Session title'}</DialogTitle><DialogDescription>{chinese ? '标题只用于区分标签，不会影响任务。' : 'The title helps identify this tab and does not interrupt the task.'}</DialogDescription></DialogHeader><input className="rounded border bg-background p-2" maxLength={120} aria-label={chinese ? '会话标题' : 'Session title'} value={rename?.title || ''} onChange={event => setRename(current => current ? { ...current, title: event.target.value } : current)} /><DialogFooter><Button variant="outline" onClick={() => setRename(null)}>{copy.cancel}</Button><Button onClick={() => { if (rename) work.rename(rename.id, rename.title); setRename(null) }}>{copy.save}</Button></DialogFooter></DialogContent></Dialog>
    <div className="work-session-bar">
      {active && <button type="button" className="companion-icon-button" aria-label={chinese ? '打开工作区当前文件夹' : 'Open current workspace folder'} title={chinese ? '在文件管理器中打开当前文件夹' : 'Open current folder in file manager'} disabled={!workspaces.some(folder => folder.id === active.workspaceId)} onClick={() => { void window.electronAPI.companion.openWorkspace(active.workspaceId, active.accessScope === 'folder' ? active.relativePath : '').catch(error => onError(error instanceof Error ? error.message : String(error))) }}><FolderOpen size={16} /></button>}
      {active && <button className="companion-icon-button" aria-label={chinese ? '修改会话标题' : 'Rename session'} title={chinese ? '修改会话标题' : 'Rename session'} onClick={() => setRename({ id: active.id, title: active.title || '' })}><Pencil size={14} /></button>}
      <div ref={strip} className="work-session-tabs" role="tablist" aria-label={chinese ? '工作会话' : 'Work sessions'}>
        {work.open.map((session, index) => {
          const info = describeWorkScope(snapshot, session)
          const selected = session.id === active?.id
          return <div key={session.id} className={'work-session-tab' + (selected ? ' is-active' : '')}>
            <button type="button" role="tab" aria-selected={selected} tabIndex={selected ? 0 : -1} title={info.paths.join('\n') + '\n' + session.model}
              onClick={() => work.activate(session.id)} onKeyDown={event => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
                event.preventDefault()
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? work.open.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + work.open.length) % work.open.length
                work.activate(work.open[next].id)
                strip.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
              }}>
              <i className="work-session-dot" data-phase={info.missing ? 'error' : mounted.has(session.id) ? phases[session.id] || 'starting' : 'idle'} aria-hidden="true" />
              <span className="work-session-name">{labels[session.id]}</span>
              {session.engine === 'claude' && <span className="work-chip">Claude</span>}
              <span className="work-chip" data-access={sessionAccess(session, info.access)}>{accessText(copy, sessionAccess(session, info.access))}</span>
            </button>
            <button type="button" className="work-session-close" aria-label={copy.closeWorkSession + ' ' + labels[session.id]} title={copy.closeWorkSession} onClick={() => closeSession(session.id)}><X size={12} /></button>
          </div>
        })}
      </div>
      <Button size="sm" variant="ghost" className="work-bar-button" disabled={!work.ready} title={full ? copy.workSessionLimit : copy.newWorkSessionTitle} onClick={openNew}><Plus size={14} className="mr-1" />{copy.newWorkSession}</Button>
      <Button size="sm" variant="ghost" className="work-bar-button" disabled={!work.recent.length} onClick={() => setRecentOpen(true)}><History size={14} className="mr-1" />{copy.recentSessions}{work.recent.length ? ' · ' + work.recent.length : ''}</Button>
    </div>
    {!work.ready ? <div className="work-panel" role="status"><LoaderCircle size={22} className="animate-spin" /></div>
      : !work.open.length ? <div className="work-panel work-empty">
        {workspaces.length ? <><TerminalIcon size={30} /><h2>{copy.workEmptyTitle}</h2>
          <Button onClick={openNew}><Plus size={15} className="mr-2" />{copy.newWorkSession}</Button></>
          : <><FolderPlus size={30} /><h2>{copy.noFoldersTitle}</h2><p>{copy.noFoldersBody}</p>
            <Button onClick={onAddFolder}><FolderPlus size={15} className="mr-2" />{copy.addFolder}</Button></>}
        {!!work.recent.length && <RecentList work={work} snapshot={snapshot} copy={copy} chinese={chinese} limit={5} onReopen={reopen} />}
      </div>
      : work.open.map(session => {
        const blocked = panel(session)
        const hidden = session.id !== active?.id
        if (blocked) return <div key={session.id} hidden={hidden}>{blocked}</div>
        if (!mounted.has(session.id)) return null
        const history = session.importFrom && !session.sessionId ? histories[session.id] : undefined
        if (history === null) return <div key={session.id} hidden={hidden} className="work-panel" role="status"><LoaderCircle size={22} className="animate-spin" /></div>
        return <Suspense key={session.id} fallback={<div hidden={hidden} className="work-panel" role="status"><LoaderCircle size={22} className="animate-spin" /></div>}><OpenCodeTerminal hidden={hidden} chinese={chinese} screenReaderMode={screenReaderMode} details={details(session)} engine={session.engine}
          prepare={() => prepare(session.model)}
          input={{ workspaceId: session.workspaceId, groupId: session.groupId, accessScope: session.accessScope, relativePath: session.relativePath, model: session.model, sessionId: session.sessionId, newSession: !session.sessionId, ...(session.engine === 'claude' ? { engine: session.engine } : history?.length ? { history } : {}) }}
          onSession={sessionId => work.connected(session.id, sessionId)}
          onPhase={phase => setPhases(current => current[session.id] === phase ? current : { ...current, [session.id]: phase })} /></Suspense>
      })}
    {creating && <NewWorkSessionDialog snapshot={snapshot} copy={copy} chinese={chinese} model={work.model} models={models} initial={work.lastScope} onClose={() => setCreating(false)} onFolders={() => { setCreating(false); onFolders() }} onAddFolder={onAddFolder}
      onCreate={(scope, model, engine) => { if (work.create(scope, model, engine)) setCreating(false); else onError(copy.workSessionLimit) }} />}
    <Dialog open={recentOpen} onOpenChange={setRecentOpen}><DialogContent className="companion-settings max-h-[80vh] max-w-xl overflow-y-auto">
      <DialogHeader><DialogTitle className="flex items-center gap-2"><History size={18} />{copy.recentSessions}</DialogTitle><DialogDescription>{copy.noRecentSessions}</DialogDescription></DialogHeader>
      <RecentList work={work} snapshot={snapshot} copy={copy} chinese={chinese} onReopen={reopen} />
    </DialogContent></Dialog>
  </div>
}

function RecentList({ work, snapshot, copy, chinese, limit, onReopen }: { work: WorkSessionsModel; snapshot: CompanionSnapshot | null; copy: CompanionCopy; chinese: boolean; limit?: number; onReopen: (id: string) => void }) {
  const items = limit ? work.recent.slice(0, limit) : work.recent
  if (!items.length) return <p className="work-recent-empty">{copy.noRecentSessions}</p>
  return <div className="work-recent" aria-label={copy.recentSessions}>
    {limit && <h3>{copy.recentSessions}</h3>}
    {items.map(session => {
      const info = describeWorkScope(snapshot, session)
      return <div key={session.id} className="work-recent-item" data-recent-session={session.id}>
        {session.groupId && session.accessScope === 'group' ? <Layers size={16} /> : <Folder size={16} />}
        <div className="min-w-0 flex-1"><p className="work-recent-name">{info.name}<span className="work-chip" data-access={info.access}>{accessText(copy, info.access)}</span></p>
          <p className="work-recent-meta" title={info.paths.join('\n')}>{session.model || '—'} · {copy.usedAt} {new Date(session.usedAt).toLocaleString(chinese ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</p>
          {info.missing && <p className="work-recent-meta text-warning">{copy.folderMissing}</p>}</div>
        <Button size="sm" variant="outline" disabled={info.missing} onClick={() => onReopen(session.id)}>{copy.reopenSession}</Button>
        <button type="button" className="companion-icon-button" aria-label={copy.forgetSession + ' ' + info.name} title={copy.forgetSessionHint} onClick={() => work.forget(session.id)}><Trash2 size={15} /></button>
      </div>
    })}
  </div>
}

/** Pick the folder (or group) a new session works in. The session keeps it for life. */
function NewWorkSessionDialog({ snapshot, copy, chinese, model: initialModel, models, initial, onClose, onCreate, onFolders, onAddFolder }: {
  snapshot: CompanionSnapshot | null; copy: CompanionCopy; chinese: boolean; model: string; models: string[]; initial?: WorkScope
  onClose: () => void; onCreate: (scope: WorkScope, model: string, engine: AgentEngine) => void; onFolders: () => void; onAddFolder: () => void
}) {
  const [model, setModel] = useState(initialModel || models[0] || '')
  const [engine, setEngine] = useState<AgentEngine>('opencode')
  const claudeAvailable = !!snapshot?.claudeCode?.available
  const engineModels = engine === 'claude' ? models.filter(id => !id.startsWith('opencode-free/')) : models
  const workspaces = snapshot?.workspaces || []
  const groups = (snapshot?.groups || []).filter(group => group.workspaceIds.some(id => workspaces.some(folder => folder.id === id)))
  const valid = (scope?: WorkScope) => !!scope && !describeWorkScope(snapshot, scope).missing
  const [scope, setScope] = useState<WorkScope | undefined>(() => valid(initial) ? initial : workspaces[0] && { workspaceId: workspaces[0].id, groupId: '', accessScope: 'group', relativePath: '' })
  const [browsing, setBrowsing] = useState<{ path: string; entries: WorkspaceEntry[]; busy: boolean; error: string } | null>(null)
  useEffect(() => { if (!scope && workspaces[0]) setScope({ workspaceId: workspaces[0].id, groupId: '', accessScope: 'group', relativePath: '' }) }, [workspaces.length])
  const group = scope?.groupId ? groups.find(item => item.id === scope.groupId) : undefined
  const members = group ? workspaces.filter(folder => group.workspaceIds.includes(folder.id)) : []
  const folder = workspaces.find(item => item.id === scope?.workspaceId)
  const info = scope ? describeWorkScope(snapshot, scope) : undefined
  const choice = !scope ? '' : scope.groupId ? 'group:' + scope.groupId : 'folder:' + scope.workspaceId
  const browse = async (path: string) => {
    if (!folder) return
    setBrowsing({ path, entries: [], busy: true, error: '' })
    try { const entries = await window.electronAPI.companion.listFiles(folder.id, path); setBrowsing({ path, entries: entries.filter(entry => entry.directory), busy: false, error: '' }) }
    catch (error) { setBrowsing({ path, entries: [], busy: false, error: error instanceof Error ? error.message : String(error) }) }
  }
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}><DialogContent className="companion-settings max-h-[88vh] max-w-lg overflow-y-auto">
    <DialogHeader><DialogTitle className="flex items-center gap-2"><TerminalIcon size={18} />{copy.newWorkSessionTitle}</DialogTitle><DialogDescription>{copy.newWorkSessionHint}</DialogDescription></DialogHeader>
    {!workspaces.length ? <div className="work-dialog-empty"><p>{copy.noFoldersBody}</p><Button variant="outline" onClick={onAddFolder}><FolderPlus size={15} className="mr-2" />{copy.addFolder}</Button></div> : <div className="grid gap-4">
      <label className="companion-field">{copy.workFolder}
        <select aria-label={copy.workFolder} value={choice} onChange={event => {
          const [kind, id] = [event.target.value.slice(0, event.target.value.indexOf(':')), event.target.value.slice(event.target.value.indexOf(':') + 1)]
          const first = kind === 'group' ? workspaces.find(item => groups.find(entry => entry.id === id)?.workspaceIds.includes(item.id)) : undefined
          setBrowsing(null)
          setScope(kind === 'group' ? { workspaceId: first?.id || '', groupId: id, accessScope: 'group', relativePath: '' } : { workspaceId: id, groupId: '', accessScope: 'group', relativePath: '' })
        }}>
          <optgroup label={copy.folders}>{workspaces.map(item => <option key={item.id} value={'folder:' + item.id}>{item.name} · {item.writable ? copy.accessEdit : copy.accessRead}</option>)}</optgroup>
          {!!groups.length && <optgroup label={copy.groupPrefix}>{groups.map(item => <option key={item.id} value={'group:' + item.id}>{copy.groupPrefix}：{item.name} · {count(copy.foldersCount, item.workspaceIds.length)}</option>)}</optgroup>}
        </select></label>
      {group && scope && <label className="companion-field">{copy.startFolder}
        <select aria-label={copy.startFolder} value={scope.workspaceId} onChange={event => setScope({ ...scope, workspaceId: event.target.value })}>{members.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
      {!group && scope && folder && <div className="companion-field">{copy.subfolder}
        <div className="work-subfolder"><span className="min-w-0 flex-1 truncate">{scope.accessScope === 'folder' && scope.relativePath ? folder.name + ' / ' + scope.relativePath : copy.wholeFolder}</span>
          {scope.accessScope === 'folder' && <Button size="sm" variant="ghost" onClick={() => { setBrowsing(null); setScope({ ...scope, accessScope: 'group', relativePath: '' }) }}>{copy.wholeFolder}</Button>}
          <Button size="sm" variant="outline" onClick={() => { void browse(scope.relativePath) }}>{copy.chooseSubfolder}</Button></div>
        {browsing && <div className="work-subfolder-browser">
          <div className="flex items-center gap-2"><Button size="sm" variant="ghost" disabled={browsing.busy || !browsing.path} onClick={() => { void browse(browsing.path.split(/[\\/]/).slice(0, -1).join('/')) }}><ChevronLeft size={15} />{copy.parent}</Button>
            <span className="min-w-0 flex-1 truncate">{folder.name}{browsing.path ? ' / ' + browsing.path : ''}</span>
            <Button size="sm" disabled={browsing.busy || !!browsing.error || !browsing.path} onClick={() => { setScope({ ...scope, accessScope: 'folder', relativePath: browsing.path }); setBrowsing(null) }}>{copy.useThisFolder}</Button></div>
          {browsing.busy ? <LoaderCircle size={16} className="m-3 animate-spin" /> : browsing.error ? <p role="alert" className="text-danger">{browsing.error}</p>
            : browsing.entries.length ? browsing.entries.map(entry => <button type="button" key={entry.relativePath} onClick={() => { void browse(entry.relativePath) }}><Folder size={14} />{entry.name}</button>)
              : <p>{copy.noFiles}</p>}
          <small>{copy.subfolderHint}</small></div>}
      </div>}
      {info && <div className="work-scope-summary" role="status">
        <p><strong>{info.name}</strong><span className="work-chip" data-access={info.access}>{accessText(copy, info.access)}</span><span className="work-chip">{info.commands ? copy.commandsAsk : copy.commandsOff}</span></p>
        {info.paths.map(path => <p key={path} className="work-scope-path">{path}</p>)}
<label className="companion-field">{copy.agentEngine}<select aria-label={copy.agentEngine} value={engine} onChange={event => {
          const next = event.target.value as AgentEngine
          setEngine(next)
          if (next === 'claude' && model.startsWith('opencode-free/')) setModel(models.find(id => !id.startsWith('opencode-free/')) || '')
        }}><option value="opencode">OpenCode v2</option><option value="claude" disabled={!claudeAvailable}>Claude Code{claudeAvailable ? '' : chinese ? '（未安装）' : ' (not installed)'}</option></select></label>
        <label className="companion-field">{copy.sessionModel}<select aria-label={copy.sessionModel} value={model} onChange={event => setModel(event.target.value)}><option value="" disabled>{copy.model}</option>{[...new Set([model, ...engineModels])].filter(Boolean).map(id => <option key={id} value={id}>{id}</option>)}</select></label>
        <button type="button" className="companion-read-button" onClick={onFolders}><FolderCog size={13} />{chinese ? '修改文件夹权限' : 'Change folder permissions'}</button>
      </div>}
    </div>}
    <DialogFooter><Button variant="outline" onClick={onClose}>{copy.cancel}</Button>
      <Button disabled={!scope || !valid(scope) || !model || (engine === 'claude' && (!claudeAvailable || model.startsWith('opencode-free/'))) || (!!scope && scope.accessScope === 'folder' && !scope.relativePath)} onClick={() => { if (scope) onCreate(scope, model, engine) }}><Plus size={15} className="mr-2" />{copy.openSession}</Button></DialogFooter>
  </DialogContent></Dialog>
}

