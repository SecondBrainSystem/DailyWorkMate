import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Folder, Plus, Trash2 } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { WorkspaceGrant, WorkspaceGroup, WorkspaceGroupInput } from '@shared/companion'

export function WorkspaceGroupsPanel({ groups, workspaces, onClose, onSave, onDelete }: {
  groups: WorkspaceGroup[]; workspaces: WorkspaceGrant[]; onClose: () => void
  onSave: (group: WorkspaceGroupInput) => Promise<void>; onDelete: (id: string) => Promise<void>
}) {
  const { t } = useTranslation()
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
    if (!name.trim() || !members.length) { setError(t('companion.groups.invalid')); return }
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
    <DialogHeader><DialogTitle>{t('companion.groups.title')}</DialogTitle><DialogDescription>{t('companion.groups.description')}</DialogDescription></DialogHeader>
    <div className="grid gap-4 sm:grid-cols-[170px_1fr]">
      <div className="grid content-start gap-2">
        <Button size="sm" variant={!id ? 'secondary' : 'outline'} disabled={busy} onClick={() => select()}><Plus size={14} className="mr-2" />{t('companion.groups.create')}</Button>
        {groups.map(group => <button key={group.id} type="button" aria-pressed={id === group.id} disabled={busy} onClick={() => select(group)} className={'rounded-lg border px-3 py-2 text-left text-sm ' + (id === group.id ? 'border-[var(--companion-accent)] bg-[var(--glass-bg)]' : 'border-[var(--glass-border)]')}><span className="block break-words">{group.name}</span><span className="text-xs text-[var(--text-muted)]">{t('companion.groups.selected', { n: group.workspaceIds.length })}</span></button>)}
      </div>
      <form className="grid content-start gap-4" onSubmit={event => { event.preventDefault(); void save() }}>
        <label className="companion-field">{t('companion.groups.name')}<input autoFocus maxLength={80} value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>
        <fieldset className="grid gap-2"><legend className="mb-2 text-sm">{t('companion.groups.folders')}</legend>
          {!workspaces.length && <p className="text-xs text-[var(--text-muted)]">{t('companion.groups.empty')}</p>}
          {workspaces.map(folder => <label key={folder.id} className="flex items-start gap-2 rounded-lg border border-[var(--glass-border)] p-2 text-xs"><input type="checkbox" className="mt-0.5" disabled={busy} checked={members.includes(folder.id)} onChange={event => setMembers(event.target.checked ? [...members, folder.id] : members.filter(member => member !== folder.id))} /><Folder size={14} className="mt-0.5 shrink-0" /><span className="min-w-0 flex-1"><span className="block break-words font-medium">{folder.name}</span><span className="block break-all text-[var(--text-muted)]">{folder.path}</span></span><span className="shrink-0 text-[var(--text-muted)]">{folder.writable ? t('companion.groups.write') : t('companion.groups.read')}</span></label>)}
        </fieldset>
        <p className="text-xs text-[var(--text-muted)]">{t('companion.groups.membersHint')}</p>
        {confirmDelete && <div className="rounded-lg border border-warning/30 p-3 text-xs"><p>{t('companion.groups.deleteHint')}</p><div className="mt-2 flex flex-wrap gap-2"><Button type="button" size="sm" variant="destructive" disabled={busy} onClick={() => void remove()}>{t('companion.groups.deleting')}</Button><Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmDelete(false)}>{t('companion.groups.back')}</Button></div></div>}
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">{id && !confirmDelete && <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmDelete(true)}><Trash2 size={14} className="mr-1" />{t('companion.groups.remove')}</Button>}<Button type="button" size="sm" variant="outline" disabled={busy} onClick={onClose}>{t('companion.groups.cancel')}</Button><Button type="submit" size="sm" disabled={busy || !workspaces.length}>{busy ? '…' : t('companion.groups.save')}</Button></div>
      </form>
    </div>
  </DialogContent></Dialog>
}
