import { useEffect, useRef, useState, type DragEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderOpen, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useErrorText } from '@/lib/errors'
import type { CompanionSnapshot, DroppedFolder } from '@shared/companion'
import type { ShellKind, TerminalState } from '@shared/terminal'

export function useFolderDrop(enabled: boolean, onDrop: (paths: string[]) => void, onError: (message: string) => void) {
  const { t } = useTranslation()
  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)
  useEffect(() => { depth.current = 0; setDragging(false) }, [enabled])
  const accepts = (event: DragEvent) => enabled && Array.from(event.dataTransfer.types).includes('Files')
  return { dragging, handlers: {
    onDragEnterCapture: (event: DragEvent) => { if (accepts(event)) { event.preventDefault(); depth.current++; setDragging(true) } },
    onDragOverCapture: (event: DragEvent) => { if (accepts(event)) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'copy' } },
    onDragLeaveCapture: (event: DragEvent) => { if (accepts(event)) { depth.current = Math.max(0, depth.current - 1); if (!depth.current) setDragging(false) } },
    onDropCapture: (event: DragEvent) => {
      if (!accepts(event)) return
      event.preventDefault(); event.stopPropagation(); depth.current = 0; setDragging(false)
      try {
        const files = Array.from(event.dataTransfer.files)
        if (!files.length || files.length > 32) throw new Error(t('folderDrop.folderCount'))
        // File.path was removed in Electron 32; webUtils resolves native File objects in preload.
        const paths = files.map(file => window.electronAPI.getPathForFile(file))
        if (paths.some(path => !path)) throw new Error(t('folderDrop.pathUnreadable'))
        onDrop(paths)
      } catch (error) { onError(error instanceof Error ? error.message : String(error)) }
    },
  } }
}

export function FolderDropDialog({ paths, target, snapshot, onClose, onImported, onTerminal }: {
  paths: string[]; target: 'workspace' | 'terminal'; snapshot: CompanionSnapshot
  onClose: () => void; onImported: (snapshot: CompanionSnapshot) => void; onTerminal: (id: string) => void
}) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const [folders, setFolders] = useState<DroppedFolder[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [action, setAction] = useState(target)
  const [group, setGroup] = useState('')
  const [groupName, setGroupName] = useState('')
  const [shells, setShells] = useState<TerminalState['shells']>([])
  const [shell, setShell] = useState<ShellKind>('powershell')
  const [directory, setDirectory] = useState('')
  const submitting = useRef(false)
  const api = window.electronAPI.companion
  useEffect(() => {
    let disposed = false
    void api.inspectFolders(paths).then(result => { if (!disposed) { setFolders(result); setDirectory(result[0]?.path || '') } })
      .catch(reason => { if (!disposed) setError(errorText(reason)) }).finally(() => { if (!disposed) setLoading(false) })
    return () => { disposed = true }
  }, [paths])
  useEffect(() => {
    if (action !== 'terminal') return
    let disposed = false
    void window.electronAPI.terminal.get().then(state => {
      if (disposed) return
      const available = state.shells.filter(item => item.kind !== 'opencode' && item.available)
      setShells(available); setShell(available[0]?.kind || 'powershell')
    }).catch(reason => { if (!disposed) setError(errorText(reason)) })
    return () => { disposed = true }
  }, [action])
  const submit = async () => {
    if (submitting.current) return
    submitting.current = true; setBusy(true); setError('')
    try {
      if (action === 'workspace') {
        const next = await api.importWorkspaces({ folders: folders.map(({ path, writable }) => ({ path, writable })),
          ...(group === '__new__' ? { newGroupName: groupName.trim() } : group ? { groupId: group } : {}) })
        onImported(next)
      } else {
        const id = crypto.randomUUID()
        await window.electronAPI.terminal.create({ id, kind: shell, directory, cols: 100, rows: 30 })
        onTerminal(id)
      }
      onClose()
    } catch (reason) { setError(errorText(reason)) }
    finally { submitting.current = false; setBusy(false) }
  }
  const changedAccess = folders.some(folder => folder.workspaceId && snapshot.workspaces.find(item => item.id === folder.workspaceId)?.writable !== folder.writable)
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}><DialogContent className="companion-settings max-h-[85vh] max-w-xl overflow-y-auto" data-folder-drop-dialog>
    <DialogHeader><DialogTitle className="flex items-center gap-2"><FolderOpen size={19} />{t('folderDrop.title')}</DialogTitle>
      <DialogDescription>{t('folderDrop.description')}</DialogDescription></DialogHeader>
    {loading ? <div role="status" className="flex items-center gap-2"><LoaderCircle size={16} className="animate-spin" />{t('folderDrop.checking')}</div> : !!folders.length && <div className="grid gap-4">
      {target === 'terminal' && <fieldset disabled={busy} className="grid gap-2"><legend className="mb-2 text-sm">{t('folderDrop.action')}</legend>
        <label className="flex gap-2 text-sm"><input type="radio" name="folder-action" checked={action === 'terminal'} onChange={() => setAction('terminal')} />{t('folderDrop.openTerminalHere')}</label>
        <label className="flex gap-2 text-sm"><input type="radio" name="folder-action" checked={action === 'workspace'} onChange={() => setAction('workspace')} />{t('folderDrop.addToWorkspaces')}</label>
      </fieldset>}
      {action === 'workspace' ? <>
        <div className="grid gap-2">{folders.map(folder => <div key={folder.path} className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--glass-border)] p-3">
          <div className="min-w-0 flex-1"><p className="break-all text-sm font-medium">{folder.name}{folder.workspaceId && <small className="ml-2 text-[var(--text-muted)]">{t('folderDrop.alreadyAuthorized')}</small>}</p><p className="break-all text-xs text-[var(--text-muted)]">{folder.path}</p></div>
          <label className="companion-field text-xs">{t('folderDrop.access')}<select aria-label={t('folderDrop.accessLabel', { name: folder.name })} disabled={busy} value={folder.writable ? 'write' : 'read'} onChange={event => { const writable = event.target.value === 'write'; setFolders(current => current.map(item => item.path === folder.path ? { ...item, writable } : item)) }}><option value="read">{t('companion.readOnly')}</option><option value="write">{t('companion.writable')}</option></select></label>
        </div>)}</div>
        <label className="companion-field">{t('folderDrop.addToGroup')}<select aria-label={t('folderDrop.groupLabel')} value={group} disabled={busy} onChange={event => setGroup(event.target.value)}><option value="">{t('folderDrop.noGroup')}</option>{snapshot.groups.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}<option value="__new__">{t('folderDrop.newGroup')}</option></select></label>
        {group === '__new__' && <label className="companion-field">{t('folderDrop.newGroupName')}<input aria-label={t('folderDrop.newGroupName')} maxLength={80} value={groupName} disabled={busy} onChange={event => setGroupName(event.target.value)} /></label>}
        <p className="text-xs text-[var(--text-muted)]">{t('folderDrop.accessHint')}</p>
        {changedAccess && <p role="status" className="text-xs text-warning">{t('folderDrop.reconnectHint')}</p>}
      </> : <>
        <label className="companion-field">{t('folderDrop.directory')}<select aria-label={t('folderDrop.directoryLabel')} disabled={busy} value={directory} onChange={event => setDirectory(event.target.value)}>{folders.map(folder => <option key={folder.path} value={folder.path}>{folder.path}</option>)}</select></label>
        <label className="companion-field">{t('folderDrop.shell')}<select aria-label={t('folderDrop.shellLabel')} disabled={busy} value={shell} onChange={event => setShell(event.target.value as ShellKind)}>{shells.map(item => <option key={item.kind} value={item.kind}>{item.kind === 'powershell' ? 'PowerShell' : item.kind.toUpperCase()}</option>)}</select></label>
        <p className="text-xs text-[var(--text-muted)]">{t('folderDrop.shellHint')}</p>
      </>}
    </div>}
    {error && <p role="alert" className="break-words text-sm text-danger">{error}</p>}
    <DialogFooter><Button variant="outline" disabled={busy} onClick={onClose}>{t('companion.cancel')}</Button><Button disabled={busy || loading || !folders.length || (action === 'workspace' ? group === '__new__' && !groupName.trim() : !directory || !shells.length)} onClick={() => void submit()}>{busy ? '…' : action === 'workspace' ? t('folderDrop.confirmAccess') : t('folderDrop.openTerminal')}
</Button></DialogFooter>
  </DialogContent></Dialog>
}
