import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen, FolderPlus, Layers, Search, Terminal, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { WorkspaceGrant, WorkspaceGroup } from '@shared/companion'
import type { WorkScope } from '@/lib/workSessions'

export function AuthorizedFolders({ chinese, workspaces, groups, disabled, embedded = false, sessionCounts = {}, onAdd, onGroups, onBrowse, onAccess, onRemove, onWork, onError }: {
  chinese: boolean; workspaces: WorkspaceGrant[]; groups: WorkspaceGroup[]; disabled: boolean
  /** Open Work sessions per `folder:<id>` / `group:<id>`, so each grant shows what uses it. */
  sessionCounts?: Record<string, number>
  /** Rendered inside the folder-access dialog: no card frame of its own. */
  embedded?: boolean
  onAdd(): void; onGroups(): void; onBrowse(id: string): void; onAccess(id: string, writable: boolean): void; onRemove(id: string): void
  /** Opens a new Work session in this folder or group. */
  onWork(scope: WorkScope): void
  onError(message: string): void
}) {
  const used = (key: string) => sessionCounts[key] ? <span className="work-chip is-used">{chinese ? sessionCounts[key] + ' 个会话' : sessionCounts[key] + (sessionCounts[key] === 1 ? ' session' : ' sessions')}</span> : null
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('*')
  const [collapsed, setCollapsed] = useState<string[]>([])
  const sections = useMemo(() => {
    const grouped = new Set(groups.flatMap(group => group.workspaceIds))
    return [...groups.map(group => ({ ...group, folders: workspaces.filter(folder => group.workspaceIds.includes(folder.id)) })),
      { id: '', name: chinese ? '未分组' : 'Ungrouped', workspaceIds: [], folders: workspaces.filter(folder => !grouped.has(folder.id)) }]
  }, [groups, workspaces, chinese])
  useEffect(() => { if (filter !== '*' && !sections.some(section => section.id === filter)) setFilter('*') }, [filter, sections])
  const term = query.trim().toLocaleLowerCase()
  const visible = sections.filter(section => filter === '*' || section.id === filter).map(section => ({ ...section,
    folders: section.folders.filter(folder => `${section.name} ${folder.name} ${folder.path}`.toLocaleLowerCase().includes(term)),
  })).filter(section => section.folders.length || (!term && !workspaces.length && !section.id))
  return <section className={embedded ? 'companion-workspaces is-embedded' : 'companion-workspaces'} aria-label={chinese ? '授权文件夹管理' : 'Authorized folder management'}>
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h2 className="flex items-center gap-2 font-medium"><Folder size={18} />{chinese ? '授权文件夹' : 'Authorized folders'} <span className="text-sm text-[var(--text-muted)]">{workspaces.length}</span></h2>
      <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={disabled} onClick={onGroups}><Layers size={15} className="mr-2" />{chinese ? '管理分组' : 'Manage groups'}</Button><Button variant="outline" size="sm" disabled={disabled} onClick={onAdd}><FolderPlus size={15} className="mr-2" />{chinese ? '添加文件夹' : 'Add folder'}</Button></div>
    </div>
    <div className="mb-4 flex flex-wrap gap-3"><label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-[var(--glass-border)] bg-[var(--bg-primary)] px-3 py-2"><Search size={17} className="shrink-0 text-[var(--text-muted)]" /><input className="min-w-0 flex-1 bg-transparent text-sm outline-none" aria-label={chinese ? '搜索授权文件夹' : 'Search authorized folders'} placeholder={chinese ? '搜索名称、路径或分组' : 'Search name, path or group'} value={query} onChange={event => setQuery(event.target.value)} /></label>
      <select className="rounded-lg border border-[var(--glass-border)] bg-[var(--bg-primary)] px-3 py-2 text-sm" aria-label={chinese ? '筛选授权分组' : 'Filter authorized groups'} value={filter} onChange={event => setFilter(event.target.value)}><option value="*">{chinese ? '所有分组' : 'All groups'}</option>{sections.map(section => <option key={section.id} value={section.id}>{section.name}</option>)}</select>
    </div>
    {!visible.length && <p className="py-3 text-sm text-[var(--text-muted)]">{chinese ? '没有匹配的授权文件夹。' : 'No matching authorized folders.'}</p>}
    {visible.map(section => <section key={section.id} data-authorized-group={section.id || 'ungrouped'} className="mb-3 overflow-hidden rounded-xl border border-[var(--glass-border)] last:mb-0">
      <div className="flex flex-wrap items-center justify-between gap-2 bg-[var(--glass-bg)] px-3 py-2"><button className="flex min-w-0 items-center gap-2 text-left font-medium" aria-expanded={!collapsed.includes(section.id)} onClick={() => setCollapsed(current => current.includes(section.id) ? current.filter(id => id !== section.id) : [...current, section.id])}>{collapsed.includes(section.id) ? <ChevronRight size={16} /> : <ChevronDown size={16} />}<span className="break-words">{section.name}</span><span className="text-sm text-[var(--text-muted)]">{section.folders.length}</span>{section.id && used('group:' + section.id)}</button>
        {section.id && !!section.folders.length && <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onWork({ workspaceId: section.folders[0].id, groupId: section.id, accessScope: 'group', relativePath: '' })}><Terminal size={15} className="mr-2" />{chinese ? '用整个分组新建会话' : 'New session with whole group'}</Button>}
      </div>
      {(!collapsed.includes(section.id) || !!term) && <div className="px-3">{!section.folders.length && <p className="py-3 text-sm text-[var(--text-muted)]">{chinese ? '添加一个文件夹开始工作。' : 'Add a folder to get started.'}</p>}
        {section.folders.map(folder => <div key={folder.id} data-authorized-folder={folder.id} className="flex flex-wrap items-center gap-3 border-t border-[var(--glass-border)] py-3 first:border-t-0"><Folder size={17} className="shrink-0 text-[var(--text-muted)]" /><div className="min-w-[140px] flex-1"><p className="break-words font-medium">{folder.name}{used('folder:' + folder.id)}</p><p className="break-all text-sm text-[var(--text-muted)]">{folder.path}</p></div>
          <div className="flex flex-wrap items-center gap-1"><select className="rounded-lg border border-[var(--glass-border)] bg-[var(--bg-primary)] p-2 text-sm" aria-label={folder.name + (chinese ? ' 访问权限' : ' access')} value={folder.writable ? 'write' : 'read'} disabled={disabled} onChange={event => onAccess(folder.id, event.target.value === 'write')}><option value="read">{chinese ? '只读' : 'Read only'}</option><option value="write">{chinese ? '可编辑' : 'Can edit'}</option></select>
            <button type="button" className="companion-icon-button" title={chinese ? '在文件管理器中打开' : 'Open in file manager'} aria-label={(chinese ? '打开文件夹 ' : 'Open folder ') + folder.name} disabled={disabled} onClick={() => { void window.electronAPI.companion.openWorkspace(folder.id).catch(error => onError(error instanceof Error ? error.message : String(error))) }}><FolderOpen size={16} /></button>
            <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onWork({ workspaceId: folder.id, groupId: '', accessScope: 'group', relativePath: '' })}><Terminal size={15} className="mr-1" />{chinese ? '新建会话' : 'New session'}</Button>
            <button className="companion-icon-button" title={chinese ? '浏览文件' : 'Browse files'} aria-label={chinese ? '浏览文件' : 'Browse files'} disabled={disabled} onClick={() => onBrowse(folder.id)}><FileText size={16} /></button><button className="companion-icon-button" title={chinese ? '移除授权' : 'Remove access'} aria-label={(chinese ? '移除授权 ' : 'Remove access ') + folder.name} disabled={disabled} onClick={() => onRemove(folder.id)}><Trash2 size={16} /></button>
          </div>
        </div>)}
      </div>}
    </section>)}
  </section>
}
