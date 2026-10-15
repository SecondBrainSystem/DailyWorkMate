import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Activity, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeading } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { LogEntry, LogLevel, OllamaNodeSummary } from '@/types/electron'

const POLL_INTERVAL_MS = 2000

function levelClass(level: LogLevel): string {
  if (level === 'error') return 'border-danger/30 bg-danger/10 text-danger'
  if (level === 'warn') return 'border-warning/30 bg-warning/10 text-warning'
  if (level === 'debug') return 'border-border bg-secondary text-muted-foreground'
  return 'border-primary/30 bg-primary/10 text-primary'
}

export function OllamaLogMonitor({ nodes }: { nodes: OllamaNodeSummary[] }) {
  const { t, i18n } = useTranslation()
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [selectedNode, setSelectedNode] = useState('all')
  const [selectedLevel, setSelectedLevel] = useState<LogLevel | 'all'>('all')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const version = useRef(0)
  const activeRequest = useRef<{ key: string; promise: Promise<void> }>()
  const nodeIds = useMemo(() => new Set(nodes.map(node => node.id)), [nodes])
  const nodeNames = useMemo(() => new Map(nodes.map(node => [node.id, node.name])), [nodes])

  const refresh = useCallback((showLoading = false) => {
    const key = `${selectedNode}:${selectedLevel}:${[...nodeIds].join(',')}`
    if (activeRequest.current?.key === key) return activeRequest.current.promise
    const requestVersion = ++version.current
    if (showLoading) setLoading(true)
    const promise = (async () => {
    try {
      const nextLogs = await window.electronAPI.logs.get({
        providerId: selectedNode === 'all' ? undefined : selectedNode,
        level: selectedLevel,
        limit: 300,
      })
      if (requestVersion !== version.current) return
      setLogs(nextLogs.filter(log => nodeIds.has(log.providerId || '')).slice(0, 100))
      setError('')
    } catch (error) {
      if (requestVersion === version.current) setError(error instanceof Error ? error.message : String(error))
    } finally {
      if (requestVersion === version.current) {
        setLoading(false)
        activeRequest.current = undefined
      }
    }
    })()
    activeRequest.current = { key, promise }
    return promise
  }, [nodeIds, selectedLevel, selectedNode])

  useEffect(() => {
    let stopped = false
    let timer: number | undefined
    const poll = async (initial = false) => {
      await refresh(initial)
      if (!stopped) timer = window.setTimeout(() => void poll(), POLL_INTERVAL_MS)
    }
    void poll(true)
    return () => {
      stopped = true
      window.clearTimeout(timer)
      version.current++
      activeRequest.current = undefined
    }
  }, [refresh])

  useEffect(() => {
    if (selectedNode !== 'all' && !nodeIds.has(selectedNode)) setSelectedNode('all')
  }, [nodeIds, selectedNode])

  return (
    <Card className="min-w-0">
      <CardHeading
        icon={Activity}
        title={t('ollama.monitor.title')}
        description={t('ollama.monitor.description')}
      />
      <CardContent>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Select value={selectedNode} onValueChange={setSelectedNode}>
            <SelectTrigger aria-label={t('ollama.monitor.allNodes')} className="w-[210px] max-w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('ollama.monitor.allNodes')}</SelectItem>
              {nodes.map(node => <SelectItem key={node.id} value={node.id}>{node.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={selectedLevel} onValueChange={value => setSelectedLevel(value as LogLevel | 'all')}>
            <SelectTrigger aria-label={t('ollama.monitor.allLevels')} className="w-[130px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('ollama.monitor.allLevels')}</SelectItem>
              <SelectItem value="error">ERROR</SelectItem>
              <SelectItem value="warn">WARN</SelectItem>
              <SelectItem value="info">INFO</SelectItem>
              <SelectItem value="debug">DEBUG</SelectItem>
            </SelectContent>
          </Select>
          <Button aria-label={t('ollama.monitor.refresh')} title={t('ollama.monitor.refresh')} variant="outline" size="icon" disabled={loading} onClick={() => void refresh(true)}>
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
        {error ? <p role="alert" className="mb-3 break-words rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">{t('ollama.monitor.failed')}: {error}</p> : null}
        <ScrollArea className="h-[360px] rounded-xl border bg-muted/20">
          {logs.length === 0 ? (
            <div className="flex h-[358px] items-center justify-center text-sm text-muted-foreground">
              {loading ? t('common.loading') : t('ollama.monitor.empty')}
            </div>
          ) : (
            <div className="divide-y">
              {logs.map(log => (
                <div key={log.id} className="space-y-1.5 p-3 font-mono text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className={cn('font-mono', levelClass(log.level))}>{log.level.toUpperCase()}</Badge>
                    <span className="tabular-nums text-muted-foreground">{new Date(log.timestamp).toLocaleString(i18n.language)}</span>
                    <span className="font-sans font-medium">{nodeNames.get(log.providerId || '') || log.providerId}</span>
                    {log.model ? <Badge variant="secondary">{log.model}</Badge> : null}
                    {log.latency !== undefined ? <span className="text-muted-foreground">{log.latency} ms</span> : null}
                  </div>
                  <p className={log.level === 'error' ? 'break-words text-danger' : 'break-words'}>{log.message}</p>
                  {log.requestId ? <p className="break-all text-muted-foreground">requestId: {log.requestId}</p> : null}
                  {log.data && Object.keys(log.data).length > 0 ? (
                    <pre className="whitespace-pre-wrap break-all text-muted-foreground">{JSON.stringify(log.data, null, 2)}</pre>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  )
}
