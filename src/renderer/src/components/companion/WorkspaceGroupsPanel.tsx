import { useState } from 'react'
import { Folder, Plus, Trash2 } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { WorkspaceGrant, WorkspaceGroup, WorkspaceGroupInput } from '@shared/companion'

export function WorkspaceGroupsPanel({ chinese, groups, workspaces, onClose, onSave, onDelete }: {
  chinese: boolean; groups: WorkspaceGroup[]; workspaces: WorkspaceGrant[]; onClose: () => void
  onSave: (group: WorkspaceGroupInput) => Promise<void>; onDelete: (id: string) => Promise<void>
}) {
  const copy = chinese ? {
    title: '工作区分组', description: '把多个授权文件夹放进一个组，共享该组的工作对话；不同组的会话独立保存。',
    create: '新建分组', name: '分组名称', folders: '组内文件夹', empty: '请先在下方添加授权文件夹。',
    selected: '个文件夹', save: '保存分组', cancel: '关闭', remove: '删除分组', deleting: '确认删除分组',
    deleteHint: '删除分组会保留文件、文件夹授权和聊天记录。', membersHint: '调整成员会保留文字记录，并为下一次任务重建 OpenCode 会话。',
    invalid: '请输入分组名称，并选择至少一个文件夹。', read: '只读', write: '可编辑', back: '取消',
  } : {
    title: 'Workspace groups', description: 'Give several authorized folders one shared work conversation. Conversations stay separate between groups.',
    create: 'New group', name: 'Group name', folders: 'Folders in this group', empty: 'Add an authorized folder below first.',
    selected: 'folders', save: 'Save group', cancel: 'Close', remove: 'Delete group', deleting: 'Confirm group deletion',
    deleteHint: 'Deleting a group preserves files, folder permissions and conversation history.', membersHint: 'Changing members keeps the text history and starts a new OpenCode session for the next task.',
    invalid: 'Enter a group name and select at least one folder.', read: 'Read only', write: 'Can edit', back: 'Cancel',
  }
  const [id, setId] = useState<string | undefined>()
  const [name, setName] = useState('')
  const [members, setMembers] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const select = (group?: WorkspaceGroup) => {
    setId(group?.id); setName(group?.name || ''); setMembers(group?.workspaceIds || []); setError(''); setConfirmDelete(false)
  }
  const save = async () => {
    if (!name.trim() || !members.length) { setError(copy.invalid); return }
    setBusy(true); setError('')
    try { await onSave({ ...(id ? { id } : {}), name: name.trim(), workspaceIds: members }); onClose() }
    catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  const remove = async () => {
    if (!id) return
    setBusy(true); setError('')
    try { await onDelete(id); select() }
    catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}><DialogContent className="companion-settings max-h-[88vh] max-w-2xl overflow-y-auto">
    <DialogHeader><DialogTitle>{copy.title}</DialogTitle><DialogDescription>{copy.description}</DialogDescription></DialogHeader>
    <div className="grid gap-4 sm:grid-cols-[170px_1fr]">
      <div className="grid content-start gap-2">
        <Button size="sm" variant={!id ? 'secondary' : 'outline'} disabled={busy} onClick={() => select()}><Plus size={14} className="mr-2" />{copy.create}</Button>
        {groups.map(group => <button key={group.id} type="button" aria-pressed={id === group.id} disabled={busy} onClick={() => select(group)} className={'rounded-lg border px-3 py-2 text-left text-sm ' + (id === group.id ? 'border-[var(--companion-accent)] bg-[var(--glass-bg)]' : 'border-[var(--glass-border)]')}><span className="block break-words">{group.name}</span><span className="text-xs text-[var(--text-muted)]">{group.workspaceIds.length} {copy.selected}</span></button>)}
      </div>
      <form className="grid content-start gap-4" onSubmit={event => { event.preventDefault(); void save() }}>
        <label className="companion-field">{copy.name}<input autoFocus maxLength={80} value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>
        <fieldset className="grid gap-2"><legend className="mb-2 text-sm">{copy.folders}</legend>
          {!workspaces.length && <p className="text-xs text-[var(--text-muted)]">{copy.empty}</p>}
          {workspaces.map(folder => <label key={folder.id} className="flex items-start gap-2 rounded-lg border border-[var(--glass-border)] p-2 text-xs"><input type="checkbox" className="mt-0.5" disabled={busy} checked={members.includes(folder.id)} onChange={event => setMembers(event.target.checked ? [...members, folder.id] : members.filter(member => member !== folder.id))} /><Folder size={14} className="mt-0.5 shrink-0" /><span className="min-w-0 flex-1"><span className="block break-words font-medium">{folder.name}</span><span className="block break-all text-[var(--text-muted)]">{folder.path}</span></span><span className="shrink-0 text-[var(--text-muted)]">{folder.writable ? copy.write : copy.read}</span></label>)}
        </fieldset>
        <p className="text-xs text-[var(--text-muted)]">{copy.membersHint}</p>
        {confirmDelete && <div className="rounded-lg border border-warning/30 p-3 text-xs"><p>{copy.deleteHint}</p><div className="mt-2 flex flex-wrap gap-2"><Button type="button" size="sm" variant="destructive" disabled={busy} onClick={() => void remove()}>{copy.deleting}</Button><Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmDelete(false)}>{copy.back}</Button></div></div>}
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">{id && !confirmDelete && <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmDelete(true)}><Trash2 size={14} className="mr-1" />{copy.remove}</Button>}<Button type="button" size="sm" variant="outline" disabled={busy} onClick={onClose}>{copy.cancel}</Button><Button type="submit" size="sm" disabled={busy || !workspaces.length}>{busy ? '…' : copy.save}</Button></div>
      </form>
    </div>
  </DialogContent></Dialog>
}
