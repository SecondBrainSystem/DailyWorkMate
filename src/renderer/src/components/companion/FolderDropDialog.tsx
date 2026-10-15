import { useEffect, useRef, useState, type DragEvent } from 'react'
import { FolderOpen, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { errorText } from '@/lib/errors'
import type { CompanionSnapshot, DroppedFolder } from '@shared/companion'
import type { ShellKind, TerminalState } from '@shared/terminal'

export function useFolderDrop(enabled: boolean, onDrop: (paths: string[]) => void, onError: (message: string) => void) {
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
        if (!files.length || files.length > 32) throw new Error('一次请拖入 1–32 个本地文件夹。 / Drop 1–32 local folders at a time.')
        // File.path was removed in Electron 32; webUtils resolves native File objects in preload.
        const paths = files.map(file => window.electronAPI.getPathForFile(file))
        if (paths.some(path => !path)) throw new Error('无法读取文件夹路径，请从系统文件管理器拖入。 / Drag folders from the system file manager.')
        onDrop(paths)
      } catch (error) { onError(error instanceof Error ? error.message : String(error)) }
    },
  } }
}

export function FolderDropDialog({ paths, target, snapshot, chinese, onClose, onImported, onTerminal }: {
  paths: string[]; target: 'workspace' | 'terminal'; snapshot: CompanionSnapshot; chinese: boolean
  onClose: () => void; onImported: (snapshot: CompanionSnapshot) => void; onTerminal: (id: string) => void
}) {
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
      .catch(reason => { if (!disposed) setError(errorText(reason, chinese)) }).finally(() => { if (!disposed) setLoading(false) })
    return () => { disposed = true }
  }, [paths])
  useEffect(() => {
    if (action !== 'terminal') return
    let disposed = false
    void window.electronAPI.terminal.get().then(state => {
      if (disposed) return
      const available = state.shells.filter(item => item.kind !== 'opencode' && item.available)
      setShells(available); setShell(available[0]?.kind || 'powershell')
    }).catch(reason => { if (!disposed) setError(errorText(reason, chinese)) })
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
    } catch (reason) { setError(errorText(reason, chinese)) }
    finally { submitting.current = false; setBusy(false) }
  }
  const changedAccess = folders.some(folder => folder.workspaceId && snapshot.workspaces.find(item => item.id === folder.workspaceId)?.writable !== folder.writable)
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}><DialogContent className="companion-settings max-h-[85vh] max-w-xl overflow-y-auto" data-folder-drop-dialog>
    <DialogHeader><DialogTitle className="flex items-center gap-2"><FolderOpen size={19} />{chinese ? '使用拖入的文件夹' : 'Use dropped folders'}</DialogTitle>
      <DialogDescription>{chinese ? '文件保留在原位置。选择用途后确认。' : 'Files stay in their original location. Choose how to use the folders.'}</DialogDescription></DialogHeader>
    {loading ? <div role="status" className="flex items-center gap-2"><LoaderCircle size={16} className="animate-spin" />{chinese ? '正在检查文件夹…' : 'Checking folders…'}</div> : !!folders.length && <div className="grid gap-4">
      {target === 'terminal' && <fieldset disabled={busy} className="grid gap-2"><legend className="mb-2 text-sm">{chinese ? '用途' : 'Action'}</legend>
        <label className="flex gap-2 text-sm"><input type="radio" name="folder-action" checked={action === 'terminal'} onChange={() => setAction('terminal')} />{chinese ? '在此目录打开终端' : 'Open a terminal here'}</label>
        <label className="flex gap-2 text-sm"><input type="radio" name="folder-action" checked={action === 'workspace'} onChange={() => setAction('workspace')} />{chinese ? '加入授权工作区' : 'Add to authorized workspaces'}</label>
      </fieldset>}
      {action === 'workspace' ? <>
        <div className="grid gap-2">{folders.map(folder => <div key={folder.path} className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--glass-border)] p-3">
          <div className="min-w-0 flex-1"><p className="break-all text-sm font-medium">{folder.name}{folder.workspaceId && <small className="ml-2 text-[var(--text-muted)]">{chinese ? '已授权' : 'Already authorized'}</small>}</p><p className="break-all text-xs text-[var(--text-muted)]">{folder.path}</p></div>
          <label className="companion-field text-xs">{chinese ? '权限' : 'Access'}<select aria-label={folder.name + (chinese ? ' 拖入权限' : ' dropped access')} disabled={busy} value={folder.writable ? 'write' : 'read'} onChange={event => { const writable = event.target.value === 'write'; setFolders(current => current.map(item => item.path === folder.path ? { ...item, writable } : item)) }}><option value="read">{chinese ? '只读' : 'Read only'}</option><option value="write">{chinese ? '可编辑' : 'Can edit'}</option></select></label>
        </div>)}</div>
        <label className="companion-field">{chinese ? '加入分组' : 'Add to group'}<select aria-label={chinese ? '拖入文件夹分组' : 'Dropped folder group'} value={group} disabled={busy} onChange={event => setGroup(event.target.value)}><option value="">{chinese ? '不添加分组（保留已有分组）' : 'No added group (keep existing groups)'}</option>{snapshot.groups.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}<option value="__new__">{chinese ? '+ 新建分组' : '+ New group'}</option></select></label>
        {group === '__new__' && <label className="companion-field">{chinese ? '新分组名称' : 'New group name'}<input aria-label={chinese ? '新分组名称' : 'New group name'} maxLength={80} value={groupName} disabled={busy} onChange={event => setGroupName(event.target.value)} /></label>}
        <p className="text-xs text-[var(--text-muted)]">{chinese ? '只读允许助手查看文件；可编辑允许助手修改文件。分组沿用每个文件夹的权限。' : 'Read only lets the assistant view files; Can edit allows changes. Groups keep each folder’s access setting.'}</p>
        {changedAccess && <p role="status" className="text-xs text-warning">{chinese ? '确认后，权限发生变化的工作区会话将重新连接。' : 'Confirming reconnects Work sessions whose access changes.'}</p>}
      </> : <>
        <label className="companion-field">{chinese ? '工作目录' : 'Working directory'}<select aria-label={chinese ? '拖入终端目录' : 'Dropped terminal directory'} disabled={busy} value={directory} onChange={event => setDirectory(event.target.value)}>{folders.map(folder => <option key={folder.path} value={folder.path}>{folder.path}</option>)}</select></label>
        <label className="companion-field">{chinese ? '终端类型' : 'Shell'}<select aria-label={chinese ? '拖入终端类型' : 'Dropped terminal shell'} disabled={busy} value={shell} onChange={event => setShell(event.target.value as ShellKind)}>{shells.map(item => <option key={item.kind} value={item.kind}>{item.kind === 'powershell' ? 'PowerShell' : item.kind.toUpperCase()}</option>)}</select></label>
        <p className="text-xs text-[var(--text-muted)]">{chinese ? '普通终端使用当前系统用户的权限，不受工作区只读设置限制。需要限制助手的文件权限时，选择“加入授权工作区”。' : 'Shells use your operating system permissions, including write access. Choose authorized workspaces to control the assistant’s folder access.'}</p>
      </>}
    </div>}
    {error && <p role="alert" className="break-words text-sm text-danger">{error}</p>}
    <DialogFooter><Button variant="outline" disabled={busy} onClick={onClose}>{chinese ? '取消' : 'Cancel'}</Button><Button disabled={busy || loading || !folders.length || (action === 'workspace' ? group === '__new__' && !groupName.trim() : !directory || !shells.length)} onClick={() => void submit()}>{busy ? '…' : action === 'workspace' ? chinese ? '确认授权' : 'Confirm access' : chinese ? '打开终端' : 'Open terminal'}</Button></DialogFooter>
  </DialogContent></Dialog>
}
