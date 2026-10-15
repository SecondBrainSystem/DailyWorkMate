import { useState, useEffect, useRef, useCallback, useMemo, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { List, type RowComponentProps } from 'react-window'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { toast } from '@/hooks/use-toast'
import { RequestLogDetail } from './RequestLogDetail'
import { useSearchParams } from 'react-router-dom'
import { Input } from '@/components/ui/input'
import { Trash2, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'

interface RequestLogEntry {
  id: string
  timestamp: number
  status: 'success' | 'error'
  statusCode: number
  method: string
  url: string
  model: string
  actualModel?: string
  providerId?: string
  providerName?: string
  accountId?: string
  accountName?: string
  requestBody?: string
  userInput?: string
  responseStatus: number
  responsePreview?: string
  latency: number
  isStream: boolean
  errorMessage?: string
  errorStack?: string
}

interface RowProps {
  logs: RequestLogEntry[]
  onSelectLog: (log: RequestLogEntry) => void
}

const ITEM_HEIGHT = 72

const SUCCESS_BADGE = 'border-[color-mix(in_srgb,var(--success)_30%,transparent)] bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-[var(--success)]'
const WARNING_BADGE = 'border-[color-mix(in_srgb,var(--warning)_30%,transparent)] bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] text-[var(--warning)]'
const ERROR_BADGE = 'border-[color-mix(in_srgb,var(--error)_30%,transparent)] bg-[color-mix(in_srgb,var(--error)_10%,transparent)] text-[var(--error)]'

function getStatusColor(status: 'success' | 'error', statusCode: number) {
  if (status === 'success') return SUCCESS_BADGE
  if (statusCode >= 400 && statusCode < 500) return WARNING_BADGE
  return ERROR_BADGE
}

function formatTime(timestamp: number, locale: string) {
  return new Date(timestamp).toLocaleString(locale, {
    month: '2-digit', day: '2-digit', hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function formatLatency(ms: number) {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

export function RequestLogList() {
  const { t, i18n } = useTranslation()
  const [params] = useSearchParams()
  const highlight = params.get('highlight')
  const [keyword, setKeyword] = useState('')
  const [page, setPage] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [logs, setLogs] = useState<RequestLogEntry[]>([])
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [selectedLog, setSelectedLog] = useState<RequestLogEntry | null>(null)
  const [statusFilter, setStatusFilter] = useState<'all' | 'success' | 'error'>('all')
  const [isLoading, setIsLoading] = useState(true)
  const [showClearDialog, setShowClearDialog] = useState(false)
  const [isClearing, setIsClearing] = useState(false)
  const logsRef = useRef<RequestLogEntry[]>([])
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerSize, setContainerSize] = useState({ width: 800, height: 400 })

  const fetchLogs = useCallback(async () => {
    try {
      const filter = statusFilter === 'all' ? {} : { status: statusFilter }
      const result = await window.electronAPI?.requestLogs?.get({ ...filter, keyword, offset: page * 100, limit: 101, summaryOnly: true })
      if (result) {
        setHasMore(result.length > 100)
        const entries = result.slice(0, 100)
        if (entries.length !== logsRef.current.length || entries.some((entry, index) => entry.id !== logsRef.current[index]?.id || entry.status !== logsRef.current[index]?.status || entry.latency !== logsRef.current[index]?.latency)) {
          logsRef.current = entries; setLogs(entries)
        }
        setLoadError('')
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    }
  }, [statusFilter, keyword, page])

  useEffect(() => { setPage(0) }, [statusFilter, keyword])
  useEffect(() => { if (highlight) void window.electronAPI.requestLogs.getById(highlight).then(log => { if (log) setSelectedLog(log) }).catch(error => setLoadError(String(error))) }, [highlight])
  const refreshLogs = useCallback(async () => {
    await fetchLogs()
  }, [fetchLogs])

  const handleManualRefresh = async () => {
    setIsRefreshing(true)
    try {
      await refreshLogs()
    } finally {
      setIsRefreshing(false)
    }
  }

  useEffect(() => {
    setIsLoading(true)
    refreshLogs().finally(() => setIsLoading(false))
  }, [refreshLogs])

  useEffect(() => {
    const interval = setInterval(() => {
      if (!document.hidden) refreshLogs().catch((error) => {
        console.error('Failed to refresh request logs:', error)
      })
    }, 3000)
    return () => clearInterval(interval)
  }, [refreshLogs])

  useEffect(() => {
    const updateSize = () => {
      if (containerRef.current) {
        setContainerSize({
          width: containerRef.current.clientWidth,
          height: Math.max(100, Math.min(600, logs.length * ITEM_HEIGHT)),
        })
      }
    }
    updateSize()
    const observer = new ResizeObserver(updateSize)
    if (containerRef.current) observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [logs.length])

  const handleClearLogs = async () => {
    setIsClearing(true)
    try {
      await window.electronAPI?.requestLogs?.clear()
      logsRef.current = []
      setLogs([])
      setShowClearDialog(false)
    } catch (error) {
      toast({
        title: t('common.error'),
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      })
    } finally {
      setIsClearing(false)
    }
  }

  const handleSelectLog = useCallback((log: RequestLogEntry) => {
    void window.electronAPI.requestLogs.getById(log.id).then(detail => setSelectedLog(detail || log)).catch(error => setLoadError(String(error)))
  }, [])

  const locale = i18n.language
  const RowComponent = useCallback(
    ({ index, style, logs: rowLogs, onSelectLog }: RowComponentProps<RowProps>): ReactElement | null => {
      const log = rowLogs[index]
      if (!log) return null

      return (
        <div
          style={style}
          className="px-2 pb-2"
          role="button" tabIndex={0}
          onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelectLog(log) } }}
          onClick={() => onSelectLog(log)}
        >
          <div className="flex h-[64px] cursor-pointer items-center gap-3 rounded-lg border border-transparent px-3 transition-colors hover:border-border hover:bg-muted/40">
            <Badge variant="outline" className={cn('min-w-[3.25rem] justify-center font-mono tabular-nums', getStatusColor(log.status, log.statusCode))}>
              {log.statusCode}
            </Badge>

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium text-sm truncate">{log.model}</span>
                {log.actualModel && log.actualModel !== log.model && (
                  <span className="text-xs text-muted-foreground">→ {log.actualModel}</span>
                )}
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                <span>{log.providerName || log.providerId}</span>
                {log.accountName && (
                  <>
                    <span>·</span>
                    <span>{log.accountName}</span>
                  </>
                )}
              </div>
            </div>

            <div className="flex items-center gap-4 text-xs text-muted-foreground flex-shrink-0">
              <span className="tabular-nums">{formatLatency(log.latency)}</span>
              <span className="tabular-nums">{formatTime(log.timestamp, locale)}</span>
            </div>
          </div>
        </div>
      )
    },
    [locale]
  )

  const rowProps = useMemo<RowProps>(() => ({
    logs,
    onSelectLog: handleSelectLog,
  }), [logs, handleSelectLog])

  return (
    <div className="flex flex-col h-full">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Input className="w-60" value={keyword} onChange={event => setKeyword(event.target.value)} aria-label={t('common.search')} placeholder={t('common.search')} />
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as 'all' | 'success' | 'error')}>
            <SelectTrigger className="w-[9rem]" aria-label={t('logs.filter')}>
              <SelectValue placeholder={t('logs.filter')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('logs.all')}</SelectItem>
              <SelectItem value="success">{t('common.success')}</SelectItem>
              <SelectItem value="error">{t('common.error')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={async () => {
            try {
              const result = await window.electronAPI.requestLogs.get({ keyword, ...(statusFilter === 'all' ? {} : { status: statusFilter }) })
              const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }))
              const link = document.createElement('a'); link.href = url; link.download = 'dailyworkmate-request-logs.json'; link.click(); URL.revokeObjectURL(url)
            } catch (error) { setLoadError(String(error)) }
          }}>{t('common.export')}</Button>
          <Button variant="outline" size="sm" onClick={handleManualRefresh} disabled={isRefreshing}>
            <RefreshCw className={cn('mr-2 h-4 w-4', isRefreshing && 'animate-spin')} />
            {t('dashboard.refresh')}
          </Button>
          <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={() => setShowClearDialog(true)} disabled={logs.length === 0}>
            <Trash2 className="mr-2 h-4 w-4" />
            {t('logs.clearLogs')}
          </Button>
        </div>
      </div>

      {loadError && <p role="alert" className="mb-3 text-sm text-destructive">{loadError}</p>}
      <div ref={containerRef} className="flex-1">
        {isLoading ? (
          <div className="flex items-center justify-center h-32 text-muted-foreground">
            {t('common.loading')}
          </div>
        ) : logs.length === 0 ? (
          <div className="flex h-32 items-center justify-center rounded-xl border border-dashed text-sm text-muted-foreground">
            {t('logs.noRequestLogs')}
          </div>
        ) : (
          <List
            rowComponent={RowComponent}
            rowCount={logs.length}
            rowHeight={ITEM_HEIGHT}
            rowProps={rowProps}
            style={{
              width: containerSize.width,
              height: containerSize.height,
            }}
            className="scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent"
          />
        )}
      </div>

      <div className="mt-3 flex items-center justify-between text-sm">
        <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(value => value - 1)}>←</Button>
        <span>{page + 1}</span>
        <Button size="sm" variant="outline" disabled={!hasMore} onClick={() => setPage(value => value + 1)}>→</Button>
      </div>
      {selectedLog && (
        <RequestLogDetail log={selectedLog} onClose={() => setSelectedLog(null)} />
      )}

      <ConfirmDialog
        open={showClearDialog}
        onOpenChange={setShowClearDialog}
        destructive
        busy={isClearing}
        title={t('logs.clearConfirm')}
        description={t('logs.clearConfirmDesc')}
        confirmLabel={t('logs.clearLogs')}
        onConfirm={handleClearLogs}
      />
    </div>
  )
}
