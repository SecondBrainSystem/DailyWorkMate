import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/hooks/use-toast'

type Entry = Awaited<ReturnType<typeof window.electronAPI.logs.get>>[number]
export function ApplicationLogs() {
  const { t, i18n } = useTranslation()
  const [entries, setEntries] = useState<Entry[]>([])
  const [keyword, setKeyword] = useState('')
  const [page, setPage] = useState(0)
  const [more, setMore] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => setPage(0), [keyword])
  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const logs = await window.electronAPI.logs.get({ keyword, offset: page * 100, limit: 101 })
        if (active) { setEntries(logs.slice(0, 100)); setMore(logs.length > 100); setError('') }
      } catch (failure) { if (active) setError(String(failure)) }
    }
    void load()
    const timer = setInterval(() => { if (!document.hidden) void load() }, 5000)
    return () => { active = false; clearInterval(timer) }
  }, [keyword, page, revision])
  const exportLogs = async () => {
    try {
      const logs = await window.electronAPI.logs.get({ keyword })
      const url = URL.createObjectURL(new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json' }))
      const link = document.createElement('a'); link.href = url; link.download = 'dailyworkmate-application-logs.json'; link.click(); URL.revokeObjectURL(url)
    } catch (failure) { setError(String(failure)) }
  }
  return <div className="space-y-3">
    <div className="flex flex-wrap gap-2">
      <Input className="w-60" value={keyword} onChange={event => setKeyword(event.target.value)} aria-label={t('common.search')} placeholder={t('common.search')} />
      <Button variant="outline" onClick={() => setRevision(value => value + 1)}>{t('dashboard.refresh')}</Button>
      <Button variant="outline" onClick={() => void exportLogs()}>{t('logs.export')}</Button>
      <Button variant="outline" onClick={async () => {
        if (!window.confirm(t('logs.app.clearConfirm'))) return
        try { await window.electronAPI.logs.clear(); setRevision(value => value + 1) }
        catch (failure) { toast({ title: t('common.error'), description: String(failure), variant: 'destructive' }) }
      }}>{t('logs.clearLogs')}</Button>
    </div>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <div className="max-h-[60vh] space-y-2 overflow-auto">
      {entries.length === 0 && <p className="p-4 text-muted-foreground">{t('logs.app.empty')}</p>}
      {entries.map(entry => <details key={entry.id} className="rounded-lg border p-3 text-sm">
        <summary className="cursor-pointer break-words"><span className="mr-2 font-mono text-muted-foreground">{new Date(entry.timestamp).toLocaleString(i18n.language)} [{entry.level}]</span>{entry.message}</summary>
        {entry.data && <pre className="mt-3 whitespace-pre-wrap break-all text-xs">{JSON.stringify(entry.data, null, 2)}</pre>}
      </details>)}
    </div>
    <div className="flex items-center justify-between"><Button variant="outline" disabled={page === 0} onClick={() => setPage(value => value - 1)}>←</Button><span>{page + 1}</span><Button variant="outline" disabled={!more} onClick={() => setPage(value => value + 1)}>→</Button></div>
  </div>
}
