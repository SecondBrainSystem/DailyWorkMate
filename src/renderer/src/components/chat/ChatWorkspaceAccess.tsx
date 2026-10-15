import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronUp, Folder, FolderPlus, RefreshCw, Settings2, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ErrorText } from '@/components/ui/error-text'
import type { AgentSnapshot, CompanionSnapshot } from '@shared/companion'
import { EMPTY_CHAT_WORKSPACE, type ChatWorkspaceSelection } from '@/lib/workspaceAgent'

const OPEN_KEY = 'dailyworkmate.chatWorkspace.open'
const readOpen = () => { try { return localStorage.getItem(OPEN_KEY) === 'true' } catch { return false } }

export function ChatWorkspaceAccess({ chinese, selection, onChange, disabled = false, snapshot: supplied, onSnapshot, trailing, collapsible = false, summary, inline = false }: {
  chinese: boolean; selection: ChatWorkspaceSelection; onChange(selection: ChatWorkspaceSelection): void
  disabled?: boolean; snapshot?: CompanionSnapshot; onSnapshot?(snapshot: CompanionSnapshot): void
  /** Extra controls on the picker row, such as the agent engine. */
  trailing?: ReactNode
  /** Folded to one summary line until opened; the choice is remembered on this device. */
  collapsible?: boolean
  /** Extra text for the folded line, such as the engine name. */
  summary?: string
  /** Sits inside a toolbar row: folded it is a compact picker, opened it takes the full row. */
  inline?: boolean
}) {
  const [expanded, setExpanded] = useState(() => !collapsible || readOpen())
  const toggle = (open: boolean) => { setExpanded(open); try { localStorage.setItem(OPEN_KEY, String(open)) } catch { /* per-device convenience only */ } }
  const [loaded, setLoaded] = useState<CompanionSnapshot | null>(null)
  const selectId = useId()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const alive = useRef(true)
  const snapshot = supplied || loaded
  const folders = snapshot?.workspaces || []
  const groups = snapshot?.groups || []
  const selected = folders.find(folder => folder.id === selection.workspaceId)
  const group = groups.find(group => group.id === selection.groupId)
  const available = !!selected && (!selection.groupId || !!group?.workspaceIds.includes(selected.id))
  const members = group ? folders.filter(folder => group.workspaceIds.includes(folder.id)) : selected ? [selected] : []
  const access = members.every(folder => folder.writable) ? chinese ? '可读写' : 'Read & write'
    : members.every(folder => !folder.writable) ? chinese ? '只读' : 'Read only' : chinese ? '部分可编辑' : 'Mixed permissions'
  const apply = (next: CompanionSnapshot) => { if (alive.current) { setLoaded(next); onSnapshot?.(next) } }
  const perform = async (work: () => Promise<CompanionSnapshot>) => {
    if (busy) return
    setBusy(true); setError('')
    try { apply(await work()) }
    catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { if (alive.current) setBusy(false) }
  }
  useEffect(() => {
    alive.current = true
    if (!supplied && window.electronAPI.companion?.get) void perform(() => window.electronAPI.companion.get())
    return () => { alive.current = false }
  }, [])
  const value = !selection.workspaceId ? 'none' : selection.groupId ? 'group:' + selection.groupId : 'folder:' + selection.workspaceId
  const choose = (value: string) => {
    if (value === 'none') { onChange({ ...EMPTY_CHAT_WORKSPACE }); return }
    const [kind, ...rest] = value.split(':')
    const id = rest.join(':')
    if (kind === 'group') {
      const group = groups.find(group => group.id === id)
      const selected = folders.find(folder => group?.workspaceIds.includes(folder.id))
      if (selected) onChange({ workspaceId: selected.id, groupId: id, accessScope: 'group', relativePath: '' })
    } else onChange({ workspaceId: id, groupId: '', accessScope: 'group', relativePath: '' })
  }
  const folded = available ? `${group ? group.name : selected.name} · ${access}` : selection.workspaceId
    ? chinese ? '工作区授权已变化' : 'Workspace access changed' : chinese ? '不访问工作区' : 'No workspace access'
  if (collapsible && !expanded && inline) return <>
    <div className="hidden h-6 w-px bg-border sm:block" aria-hidden="true" />
    <section data-chat-workspace={selection.workspaceId} className="min-w-0 max-w-full text-sm" aria-label={chinese ? '聊天工作区访问' : 'Chat workspace access'}>
      <button type="button" data-workspace-toggle aria-expanded={false} className="inline-flex h-10 min-w-0 max-w-[24rem] items-center gap-2 rounded-md border bg-background px-3 text-left hover:bg-muted/60" title={available ? selected.path : chinese ? '选择工作区' : 'Choose a workspace'} onClick={() => toggle(true)}>
        <Folder size={15} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{folded}</span>
        {summary && <span className="shrink-0 text-muted-foreground">· {summary}</span>}
        <ChevronDown size={15} className="shrink-0 text-muted-foreground" />
      </button>
      {error && <p role="alert" className="mt-1 text-destructive"><ErrorText error={error} /></p>}
    </section>
  </>
  if (collapsible && !expanded) return <section data-chat-workspace={selection.workspaceId} className="rounded-lg border bg-card text-sm" aria-label={chinese ? '聊天工作区访问' : 'Chat workspace access'}>
    <button type="button" data-workspace-toggle aria-expanded={false} className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left" title={available ? selected.path : undefined} onClick={() => toggle(true)}>
      <Folder size={15} className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate">{folded}</span>
      {summary && <span className="shrink-0 text-muted-foreground">· {summary}</span>}
      <ChevronDown size={15} className="ml-auto shrink-0 text-muted-foreground" />
    </button>
    {error && <p role="alert" className="px-3 pb-2 text-destructive"><ErrorText error={error} /></p>}
  </section>
  return <section data-chat-workspace={selection.workspaceId} className={(inline ? 'basis-full bg-background/40 ' : 'bg-card ') + 'rounded-lg border px-3 py-2 text-sm'} aria-label={chinese ? '聊天工作区访问' : 'Chat workspace access'}>
    <div className="flex flex-wrap items-center gap-2">
      <Folder size={16} className="shrink-0 text-muted-foreground" />
      <label htmlFor={selectId} className="shrink-0">{chinese ? '工作区' : 'Workspace'}</label>
      <select id={selectId} aria-label={chinese ? '聊天工作区' : 'Chat workspace'} value={value} disabled={disabled || busy} onChange={event => choose(event.target.value)} className="min-w-[10rem] flex-1 rounded-md border bg-background p-2 sm:max-w-md">
        <option value="none">{chinese ? '不访问工作区' : 'No workspace access'}</option>
        {selection.workspaceId && !available && <option value={value} disabled>{chinese ? '原工作区已不可用，请重新选择' : 'Saved workspace unavailable — select again'}</option>}
        {!!groups.length && <optgroup label={chinese ? '整个分组' : 'Whole group'}>{groups.filter(group => folders.some(folder => group.workspaceIds.includes(folder.id))).map(group => <option key={group.id} value={'group:' + group.id}>{group.name}</option>)}</optgroup>}
        <optgroup label={chinese ? '授权文件夹' : 'Authorized folders'}>{folders.map(folder => <option key={folder.id} value={'folder:' + folder.id}>{folder.name} · {folder.writable ? chinese ? '可读写' : 'Read & write' : chinese ? '只读' : 'Read only'}</option>)}</optgroup>
      </select>
      <Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => setOpen(true)}><Settings2 size={14} className="mr-1" />{chinese ? '管理授权' : 'Manage access'}</Button>
      <Button size="icon" variant="ghost" disabled={disabled || busy} aria-label={chinese ? '刷新工作区' : 'Refresh workspaces'} onClick={() => void perform(() => window.electronAPI.companion.get())}><RefreshCw size={14} /></Button>
      {trailing}
      {collapsible && <Button size="icon" variant="ghost" data-workspace-toggle aria-expanded={true} aria-label={chinese ? '收起工作区设置' : 'Collapse workspace settings'} title={chinese ? '收起' : 'Collapse'} className="ml-auto" onClick={() => toggle(false)}><ChevronUp size={15} /></Button>}
    </div>
    {!!selection.workspaceId && <p className="mt-2 break-all text-xs text-muted-foreground">{available ? `${group ? group.name + ' · ' : ''}${selected.path}${selection.relativePath ? ' / ' + selection.relativePath : ''} · ${access}` : chinese ? '授权已变化，请选择有效工作区后再发送。' : 'Access changed. Select an available workspace before sending.'}</p>}
    {error && <p role="alert" className="mt-2 text-destructive"><ErrorText error={error} /></p>}
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto"><DialogHeader><DialogTitle>{chinese ? '聊天工作区授权' : 'Chat workspace access'}</DialogTitle><DialogDescription>{chinese ? '与助手、工作模式共享文件夹授权。可在下方设置只读或可读写。' : 'Folders are shared with Assistant and Work mode. Choose read-only or read and write access below.'}</DialogDescription></DialogHeader>
      <div><Button size="sm" disabled={disabled || busy} onClick={() => void perform(() => window.electronAPI.companion.addWorkspace())}><FolderPlus size={15} className="mr-1" />{chinese ? '添加文件夹' : 'Add folder'}</Button></div>
      {!folders.length && <p className="text-sm text-muted-foreground">{chinese ? '尚未授权文件夹。' : 'No folders are authorized.'}</p>}
      {folders.map(folder => <div className="flex flex-wrap items-center gap-2 rounded-md border p-3" key={folder.id}><div className="min-w-0 flex-1"><p className="font-medium">{folder.name}</p><p className="break-all text-xs text-muted-foreground">{folder.path}</p></div>
        <select aria-label={folder.name + (chinese ? ' 访问权限' : ' access')} className="rounded-md border bg-background p-2 text-sm" disabled={disabled || busy} value={folder.writable ? 'write' : 'read'} onChange={event => void perform(() => window.electronAPI.companion.updateWorkspace(folder.id, event.target.value === 'write'))}><option value="read">{chinese ? '只读' : 'Read only'}</option><option value="write">{chinese ? '可读写' : 'Read & write'}</option></select>
        <Button size="icon" variant="ghost" disabled={disabled || busy} aria-label={(chinese ? '撤销授权 ' : 'Remove access ') + folder.name} onClick={() => void perform(() => window.electronAPI.companion.updateWorkspace(folder.id, null))}><Trash2 size={15} /></Button></div>)}
      {error && <p role="alert" className="text-destructive"><ErrorText error={error} /></p>}
    </DialogContent></Dialog>
  </section>
}

export function WorkspaceAgentStatus({ chinese, snapshot, onReply, disabled = false, showTools = true }: {
  chinese: boolean; snapshot: AgentSnapshot | null; onReply?(id: string, allow: boolean): Promise<void>; disabled?: boolean; showTools?: boolean
}) {
  const [replying, setReplying] = useState('')
  const [error, setError] = useState('')
  if (!snapshot) return null
  const reply = async (id: string, allow: boolean) => {
    setReplying(id); setError('')
    try { await onReply?.(id, allow) }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setReplying('') }
  }
  return <div data-agent-activity={snapshot.sessionId} className="space-y-2 text-xs" aria-live="polite">
    {error && <p role="alert" className="text-destructive"><ErrorText error={error} /></p>}
    {showTools && !!snapshot.tools.length && <details className="mt-2 rounded-md border p-2" open={snapshot.running || undefined}><summary className="cursor-pointer">{chinese ? '工作区操作' : 'Workspace actions'} · {snapshot.tools.length}</summary><ul className="mt-2 space-y-1">{snapshot.tools.map(tool => <li key={tool.id} className="break-words">{tool.name} · {tool.status}{tool.title ? ' · ' + tool.title : ''}</li>)}</ul></details>}
    {snapshot.permissions.map(permission => <div role="alert" className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3" key={permission.id}><p className="font-medium">{chinese ? '工作区操作需要确认' : 'Workspace action needs approval'} · {permission.permission}</p><pre className="mt-1 whitespace-pre-wrap break-all font-sans">{permission.patterns.join('\n')}</pre><div className="mt-2 flex gap-2"><Button size="sm" disabled={disabled || !!replying || !onReply} onClick={() => void reply(permission.id, true)}>{chinese ? '允许本次' : 'Allow once'}</Button><Button size="sm" variant="outline" disabled={disabled || !!replying || !onReply} onClick={() => void reply(permission.id, false)}>{chinese ? '拒绝' : 'Reject'}</Button></div></div>)}
  </div>
}
