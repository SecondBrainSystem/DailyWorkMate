import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { History, LoaderCircle, RefreshCw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { ErrorText } from '@/components/ui/error-text'
import type { ChatHistorySummary } from '@/lib/chatHistory'

export function ChatHistoryDialog({ open, onOpenChange, items, activeId, busy, loading, error, onLoad, onDelete, onRefresh, contextLabel, scopeLabel }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  items: ChatHistorySummary[]
  activeId: string
  busy: boolean
  loading: boolean
  error: string
  onLoad: (id: string) => void
  onDelete: (id: string) => Promise<void>
  onRefresh: () => void
  contextLabel?: string
  scopeLabel?: (item: ChatHistorySummary) => string
}) {
  const { t, i18n } = useTranslation()
  const [query, setQuery] = useState('')
  const [deleteId, setDeleteId] = useState<string>()
  const [limit, setLimit] = useState(50)
  useEffect(() => { if (!open) { setDeleteId(undefined); setQuery(''); setLimit(50) } }, [open])
  const search = query.trim().toLocaleLowerCase()
  const filtered = items.filter(item => `${item.title} ${item.preview} ${item.model} ${scopeLabel?.(item) || ''}`.toLocaleLowerCase().includes(search))
  const formatDate = (value: number) => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(value)
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="flex max-h-[85dvh] w-[calc(100%_-_2rem)] max-w-2xl flex-col gap-4 overflow-hidden">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2"><History className="h-5 w-5 text-primary" />{t('chat.history.title')}</DialogTitle>
        <DialogDescription>{contextLabel ? contextLabel + ' · ' : ''}{t('chat.history.description')}</DialogDescription>
      </DialogHeader>
      <div className="flex items-center gap-2">
        <Input aria-label={t('chat.history.search')} placeholder={t('chat.history.search')} value={query} onChange={event => { setQuery(event.target.value); setLimit(50) }} />
        <Button variant="outline" size="icon" className="shrink-0" aria-label={t('chat.history.refresh')} title={t('chat.history.refresh')} onClick={onRefresh} disabled={busy || loading}>
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
        </Button>
      </div>
      {error && <p role="alert" className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger"><ErrorText error={error} /></p>}
      <div className="min-h-0 flex-1 overflow-y-auto" aria-busy={busy || loading}>
        {loading && items.length === 0 ? <p role="status" className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground"><LoaderCircle className="h-4 w-4 animate-spin" />{t('common.loading')}</p>
          : filtered.length === 0 ? <p className="rounded-xl border border-dashed py-10 text-center text-sm text-muted-foreground">{t(search ? 'chat.history.noResults' : 'chat.history.empty')}</p>
          : <ul className="space-y-2">
            {filtered.slice(0, limit).map(item => <li key={item.id} data-conversation-id={item.id} className={cn('rounded-lg border border-border/70 transition-colors', item.id === activeId && 'border-primary/50 bg-primary/5')}>
              <div className="flex items-start gap-1 p-1">
                <button type="button" disabled={busy} aria-current={item.id === activeId ? 'true' : undefined} onClick={() => onLoad(item.id)} className="min-w-0 flex-1 rounded-md p-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-medium" title={item.title}>{item.title || t('chat.history.untitled')}</span>
                    {item.id === activeId && <span className="shrink-0 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">{t('chat.history.current')}</span>}
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">{item.preview || t('chat.history.draft')}</p>
                  {scopeLabel && <p className="mt-2 break-words text-sm text-primary">{scopeLabel(item)}</p>}
                  <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span className="min-w-0 break-all">{item.model || t('chat.selectModel')}</span>
                    <span className="tabular-nums">{t('chat.history.messages', { count: item.messageCount })}</span>
                    <time dateTime={new Date(item.updatedAt).toISOString()}>{formatDate(item.updatedAt)}</time>
                  </p>
                </button>
                <Button variant="ghost" size="icon" className="h-11 w-11 shrink-0 text-muted-foreground hover:bg-danger/10 hover:text-danger" disabled={busy} title={t('common.delete')} aria-label={t('chat.history.deleteNamed', { title: item.title || t('chat.history.untitled') })} onClick={() => setDeleteId(item.id)}><Trash2 className="h-4 w-4" /></Button>
              </div>
              {deleteId === item.id && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-danger/20 bg-danger/5 p-3">
                <p className="mr-auto text-sm">{t('chat.history.confirmDelete')}</p>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => setDeleteId(undefined)}>{t('common.cancel')}</Button>
                <Button size="sm" variant="destructive" disabled={busy} onClick={() => { void onDelete(item.id).then(() => setDeleteId(undefined)) }}>{t('common.delete')}</Button>
              </div>}
            </li>)}
          </ul>}
        {filtered.length > limit && <Button variant="ghost" className="mt-3 w-full" onClick={() => setLimit(current => current + 50)}>{t('chat.history.showMore')}</Button>}
      </div>
      <p className="text-xs text-muted-foreground">{t('chat.history.localOnly')}</p>
    </DialogContent>
  </Dialog>
}
