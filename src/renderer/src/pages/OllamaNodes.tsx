import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Cpu,
  Eye,
  Link2,
  Pin,
  Plus,
  RefreshCw,
  Network,
  Server,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Card, CardContent, CardDescription, CardHeader, CardHeading, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { OllamaLogMonitor } from '@/components/ollama/OllamaLogMonitor'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import type { AppConfig, OllamaAuthInput, OllamaAuthType, OllamaNodeSummary } from '@/types/electron'
import { isOllamaModelUsable } from '../../../shared/ollamaAvailability'

type AuthDraft = OllamaAuthInput

const SUCCESS_PILL = 'border-success/30 bg-success/10 text-success'
const DANGER_PILL = 'border-danger/30 bg-danger/10 text-danger'
const NEUTRAL_PILL = 'border-border bg-secondary text-muted-foreground'

function visionClass(vision: string): string {
  if (vision === 'supported') return SUCCESS_PILL
  return NEUTRAL_PILL
}

function statusClass(status: string | undefined): string {
  if (status === 'online') return SUCCESS_PILL
  if (status === 'offline') return DANGER_PILL
  return NEUTRAL_PILL
}

export function OllamaNodes() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [nodes, setNodes] = useState<OllamaNodeSummary[]>([])
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [importing, setImporting] = useState(false)
  const [scanProgress, setScanProgress] = useState('')
  const [modelProgress, setModelProgress] = useState<{ providerId: string; model: string; completed: number; total: number }[]>([])
  const [activeTests, setActiveTests] = useState<Record<string, string>>({})
  const [stopping, setStopping] = useState<Set<string>>(new Set())
  const scanCancelled = useRef(false)
  const [manualUrl, setManualUrl] = useState('')
  const [pendingDelete, setPendingDelete] = useState<OllamaNodeSummary | null>(null)
  const [authDrafts, setAuthDrafts] = useState<Record<string, AuthDraft>>({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [importErrors, setImportErrors] = useState<string[]>([])
  const [savingRouting, setSavingRouting] = useState(false)
  const busyRef = useRef(new Set<string>())
  const importingRef = useRef(false)
  const savingRoutingRef = useRef(false)
  const loadVersion = useRef(0)
  const fileInput = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    const version = ++loadVersion.current
    setLoading(true)
    setLoadError('')
    try {
      const [nextNodes, nextConfig] = await Promise.all([
        window.electronAPI.ollama.list(),
        window.electronAPI.config.get(),
      ])
      if (version !== loadVersion.current) return
      setNodes(nextNodes)
      setConfig(nextConfig)
      setAuthDrafts(current => Object.fromEntries(nextNodes.map(node => [
        node.id,
        current[node.id] || { type: node.authTypeLabel },
      ])))
    } catch (error) {
      if (version === loadVersion.current) setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      if (version === loadVersion.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = setInterval(() => { if (!document.hidden && !busyRef.current.size && !importingRef.current) void window.electronAPI.ollama.list().then(setNodes).catch(error => setLoadError(String(error))) }, 5000)
    return () => { loadVersion.current++; scanCancelled.current = true; clearInterval(timer) }
  }, [load])

  useEffect(() => {
    let active = true
    let polling = false
    const refresh = async () => {
      if (document.hidden || polling) return
      polling = true
      try {
        const progress = await window.electronAPI.ollama.getScanProgress()
        if (active) {
          setModelProgress(progress)
          if (progress.length) {
            const latest = await window.electronAPI.ollama.list()
            if (active) setNodes(latest)
          }
        }
      } catch (error) {
        if (active) setLoadError(String(error))
      } finally {
        polling = false
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 1000)
    return () => { active = false; clearInterval(timer) }
  }, [])

  const cancelScans = async (providerId?: string) => {
    if (!providerId || scanProgress) scanCancelled.current = true
    const ids = providerId ? [providerId] : [...new Set([...Object.keys(activeTests), ...modelProgress.map(progress => progress.providerId)])]
    setStopping(current => new Set([...current, ...ids]))
    try {
      await Promise.all(ids.map(id => window.electronAPI.ollama.cancelScan(id)))
    } catch (error) { setLoadError(String(error)) }
    finally { setStopping(current => new Set([...current].filter(id => !ids.includes(id)))) }
  }

  const scanNodes = async (nextNodes: OllamaNodeSummary[]) => {
    scanCancelled.current = false
    try {
      for (let index = 0; index < nextNodes.length; index++) {
        if (scanCancelled.current) break
        const node = nextNodes[index]
        setScanProgress(`${index + 1}/${nextNodes.length} · ${node.name}`)
        await runTest(node.id, '', async () => updateNode(await window.electronAPI.ollama.scan(node.id)))
      }
    } finally { setScanProgress('') }
  }

  const pinnedModels = useMemo(() => {
    const result = new Map<string, string>()
    for (const [model, mapping] of Object.entries(config?.modelMappings || {})) {
      const id = mapping.preferredProviderId
      if (id && (id.startsWith('ollama-') || nodes.some(node => node.id === id))) result.set(model, id)
    }
    return result
  }, [config, nodes])

  const routing = config?.ollamaRouting || {
    forceModel: false,
    model: '',
    autoSelectUrl: false,
    providerId: '',
  }

  const availableModels = useMemo(() => Array.from(new Set(nodes
    .filter(node => node.enabled)
    .flatMap(node => Object.values(node.ollamaModels || {})
      .filter(model => isOllamaModelUsable(node, model) && !node.disabledModels.includes(model.name))
      .map(model => model.name))))
    .sort((left, right) => left.localeCompare(right)), [nodes])

  const fixedNodeOptions = useMemo(() => nodes.filter(node => {
    if (!node.enabled || node.status === 'offline') return false
    if (!routing.model) return true
    const model = node.ollamaModels?.[routing.model]
    return isOllamaModelUsable(node, model) && !node.disabledModels.includes(routing.model)
  }), [nodes, routing.model])

  const onlineCount = nodes.filter(node => node.enabled && node.status === 'online').length
  const totalModelCount = new Set(nodes.flatMap(node => Object.keys(node.ollamaModels || {}))).size

  const runBusy = async (id: string, operation: () => Promise<void>) => {
    if (busyRef.current.has(id)) return
    busyRef.current = new Set(busyRef.current).add(id)
    setBusy(current => new Set(current).add(id))
    try {
      await operation()
    } catch (error) {
      if (/scan cancelled/i.test(String(error))) return
      toast({
        title: t('common.error'),
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      })
    } finally {
      busyRef.current = new Set([...busyRef.current].filter(item => item !== id))
      setBusy(current => {
        const next = new Set(current)
        next.delete(id)
        return next
      })
    }
  }

  const runTest = (id: string, model: string, operation: () => Promise<void>) => runBusy(id, async () => {
    setActiveTests(current => ({ ...current, [id]: model }))
    try { await operation() }
    finally {
      setActiveTests(current => Object.fromEntries(Object.entries(current).filter(([key]) => key !== id)))
      setModelProgress(current => current.filter(progress => progress.providerId !== id))
      // A cancelled refresh still has useful completed results and untested rows.
      try { setNodes(await window.electronAPI.ollama.list()) }
      catch (error) { setLoadError(String(error)) }
    }
  })

  const importUrls = async (text: string) => {
    if (importingRef.current) return false
    importingRef.current = true
    setImporting(true)
    setImportErrors([])
    try {
      const result = await window.electronAPI.ollama.importText(text)
      setNodes(result.nodes)
      await scanNodes(result.nodes.filter(node => node.status === 'unknown'))
      setImportErrors(result.invalid)
      setConfig(await window.electronAPI.config.get())
      toast({
        title: t('ollama.importComplete'),
        description: t('ollama.importSummary', {
          imported: result.imported,
          refreshed: result.refreshed,
          invalid: result.invalid.length,
        }),
      })
      return result.invalid.length === 0
    } catch (error) {
      toast({
        title: t('ollama.importFailed'),
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      })
      return false
    } finally {
      importingRef.current = false
      setImporting(false)
    }
  }

  const handleImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file) {
      try { await importUrls(await file.text()) } catch (error) {
        toast({ title: t('ollama.importFailed'), description: error instanceof Error ? error.message : String(error), variant: 'destructive' })
      }
    }
  }

  const handleManualAdd = async () => {
    if (!manualUrl.trim()) return
    if (await importUrls(manualUrl)) setManualUrl('')
  }

  const saveRouting = async (updates: Partial<AppConfig['ollamaRouting']>) => {
    if (!config || savingRoutingRef.current) return
    savingRoutingRef.current = true
    setSavingRouting(true)
    const nextRouting = { ...routing, ...updates }
    try {
      const saved = await window.electronAPI.config.update({ ollamaRouting: nextRouting })
      if (saved === false) throw new Error(t('ollama.routing.saveFailed'))
      setConfig(current => current ? { ...current, ollamaRouting: nextRouting } : current)
    } catch (error) {
      toast({
        title: t('common.error'),
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      })
    } finally {
      savingRoutingRef.current = false
      setSavingRouting(false)
    }
  }

  const toggleForceModel = async (enabled: boolean) => {
    const model = availableModels.includes(routing.model) ? routing.model : availableModels[0] || ''
    if (enabled && !model) {
      toast({ title: t('ollama.routing.noModels'), variant: 'destructive' })
      return
    }
    const compatibleNodes = nodes.filter(node => {
      const metadata = node.ollamaModels?.[model]
      return node.enabled && isOllamaModelUsable(node, metadata) && !node.disabledModels.includes(model)
    })
    const providerId = compatibleNodes.some(node => node.id === routing.providerId)
      ? routing.providerId
      : compatibleNodes[0]?.id || ''
    await saveRouting({ forceModel: enabled, model, providerId })
  }

  const selectRoutingModel = async (model: string) => {
    const compatibleNodes = nodes.filter(node => {
      const metadata = node.ollamaModels?.[model]
      return node.enabled && isOllamaModelUsable(node, metadata) && !node.disabledModels.includes(model)
    })
    const providerId = compatibleNodes.some(node => node.id === routing.providerId)
      ? routing.providerId
      : compatibleNodes[0]?.id || ''
    await saveRouting({ model, providerId })
  }

  const toggleExpanded = (id: string) => {
    setExpanded(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const updateNode = (updated: OllamaNodeSummary) => {
    setNodes(current => current.map(node => node.id === updated.id ? updated : node))
  }

  const updateAuthDraft = (nodeId: string, updates: Partial<AuthDraft>) => {
    setAuthDrafts(current => ({
      ...current,
      [nodeId]: { ...(current[nodeId] || { type: 'none' }), ...updates },
    }))
  }

  return (
    <div className="min-w-0 space-y-5" data-ollama-ready={!loading && !loadError}>
      <PageHeader
        icon={Network}
        title={t('ollama.title')}
        description={t('ollama.description')}
        actions={<Button variant="outline" disabled={importing || busy.size > 0 || modelProgress.length > 0 || loading || !nodes.length} onClick={() => void scanNodes(nodes)}><RefreshCw className="mr-2 h-4 w-4" />{t('ollama.scanAll')}</Button>}
      />
      {(scanProgress || modelProgress.length > 0 || Object.keys(activeTests).length > 0) && <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
        <p role="status" className="min-w-0 break-all">{t('ollama.scanning')} · {scanProgress}{modelProgress.map(progress => ` · ${progress.completed}/${progress.total} ${progress.model}`).join('')}</p>
        <Button size="sm" variant="outline" disabled={stopping.size > 0} onClick={() => void cancelScans()}>{t('ollama.stopAllTests')}</Button>
      </div>}

      {loadError ? <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-danger/30 bg-danger/5 p-4 text-sm">
        <AlertTriangle className="h-4 w-4 shrink-0 text-danger" />
        <p className="min-w-0 flex-1 break-words text-danger">{loadError}</p>
        <Button variant="outline" disabled={loading} onClick={() => void load()}>{t('common.retry')}</Button>
      </div> : null}
      {loading ? <p role="status" className="text-sm text-muted-foreground">{t('common.loading')}</p> : null}

      <div className="grid gap-4 sm:grid-cols-3">
        {[
          { icon: Server, value: nodes.length, label: t('ollama.summary.nodes') },
          { icon: Activity, value: onlineCount, label: t('ollama.summary.available') },
          { icon: Cpu, value: totalModelCount, label: t('ollama.summary.models') },
        ].map(({ icon: Icon, value, label }) => (
          <Card key={label}>
            <CardContent className="flex items-center gap-3 p-5">
              <span className="card-heading-icon"><Icon /></span>
              <div className="min-w-0">
                <p className="text-2xl font-bold tabular-nums tracking-tight">{value}</p>
                <p className="truncate text-[0.8125rem] text-muted-foreground">{label}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(340px,0.75fr)]">
        <Card className="min-w-0">
          <CardHeading icon={Sparkles} title={t('ollama.routing.title')} description={t('ollama.routing.description')} />
          <CardContent className="space-y-5">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-3 rounded-xl border bg-muted/25 p-4">
                <div className="flex items-center justify-between gap-4">
                  <div><Label>{t('ollama.routing.forceModel')}</Label><p className="mt-1 text-xs text-muted-foreground">{t('ollama.routing.forceModelHint')}</p></div>
                  <Switch aria-label={t('ollama.routing.forceModel')} disabled={loading || !config || savingRouting} checked={routing.forceModel} onCheckedChange={enabled => void toggleForceModel(enabled)} />
                </div>
                <Select value={routing.model} onValueChange={model => void selectRoutingModel(model)} disabled={savingRouting || !routing.forceModel || availableModels.length === 0}>
                  <SelectTrigger aria-label={t('ollama.routing.selectModel')}><SelectValue placeholder={t('ollama.routing.selectModel')} /></SelectTrigger>
                  <SelectContent>
                    {routing.model && !availableModels.includes(routing.model) ? <SelectItem value={routing.model} disabled>{routing.model} · {t('ollama.unavailable')}</SelectItem> : null}
                    {availableModels.map(model => <SelectItem key={model} value={model}>{model}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-3 rounded-xl border bg-muted/25 p-4">
                <div className="flex items-center justify-between gap-4">
                  <div><Label>{t('ollama.routing.autoUrl')}</Label><p className="mt-1 text-xs text-muted-foreground">{t('ollama.routing.autoUrlHint')}</p></div>
                  <Switch aria-label={t('ollama.routing.autoUrl')} disabled={loading || !config || savingRouting} checked={routing.autoSelectUrl} onCheckedChange={autoSelectUrl => void saveRouting({ autoSelectUrl })} />
                </div>
                <Select value={routing.providerId} onValueChange={providerId => void saveRouting({ providerId })} disabled={savingRouting || routing.autoSelectUrl || !routing.forceModel || fixedNodeOptions.length === 0}>
                  <SelectTrigger aria-label={t('ollama.routing.selectNode')}><SelectValue placeholder={t('ollama.routing.selectNode')} /></SelectTrigger>
                  <SelectContent>
                    {routing.providerId && !fixedNodeOptions.some(node => node.id === routing.providerId) ? <SelectItem value={routing.providerId} disabled>{t('ollama.unavailable')}</SelectItem> : null}
                    {fixedNodeOptions.map(node => <SelectItem key={node.id} value={node.id}>{node.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {(routing.forceModel || routing.autoSelectUrl) ? (
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-sm">
                <Badge>{t('ollama.routing.active')}</Badge>
                <span className="min-w-0 break-all text-muted-foreground">{routing.forceModel ? routing.model : t('ollama.routing.clientModel')}</span>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
                <span>{routing.autoSelectUrl ? t('ollama.routing.automaticNode') : fixedNodeOptions.find(node => node.id === routing.providerId)?.name || t('ollama.routing.nodeRequired')}</span>
              </div>
            ) : null}
            {savingRouting ? <p role="status" className="text-xs text-muted-foreground">{t('ollama.routing.saving')}</p> : null}
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeading icon={Plus} title={t('ollama.add.title')} description={t('ollama.add.description')} />
          <CardContent className="space-y-4">
            <div className="flex gap-2">
              <Input
                aria-label={t('ollama.add.urlLabel')}
                value={manualUrl}
                onChange={event => setManualUrl(event.target.value)}
                onKeyDown={event => { if (event.key === 'Enter') void handleManualAdd() }}
                placeholder="http://127.0.0.1:11434"
                disabled={importing || loading || busy.size > 0}
                className="min-w-0"
              />
              <Button onClick={() => void handleManualAdd()} disabled={importing || loading || busy.size > 0 || !manualUrl.trim()} className="shrink-0 gap-2"><Plus className="h-4 w-4" />{t('ollama.add.button')}</Button>
            </div>
            <div className="relative flex items-center"><div className="h-px flex-1 bg-border" /><span className="px-3 text-xs text-muted-foreground">{t('ollama.add.or')}</span><div className="h-px flex-1 bg-border" /></div>
            <div className="relative">
              <input ref={fileInput} type="file" accept=".txt,text/plain" className="hidden" aria-label={t('ollama.importTxt')} onChange={handleImport} disabled={importing} />
              <Button disabled={importing || loading || busy.size > 0} variant="outline" className="w-full gap-2" onClick={() => fileInput.current?.click()}><Upload className="h-4 w-4" />{importing ? t('ollama.importing') : t('ollama.importTxt')}</Button>
            </div>
            {importErrors.length > 0 ? <div role="alert" className="space-y-1 rounded-lg border border-danger/30 bg-danger/5 p-3 text-sm text-danger">
              <p className="font-medium">{t('ollama.invalidUrls')}</p>
              <ul className="max-h-32 overflow-auto font-mono text-xs">{importErrors.map((value, index) => <li key={index} className="break-all">{value}</li>)}</ul>
            </div> : null}
          </CardContent>
        </Card>
      </div>

      <div className="flex gap-2.5 rounded-xl border border-warning/30 bg-warning/10 p-3 text-sm">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <span>{t('ollama.securityWarning')}</span>
      </div>

      {[...pinnedModels].filter(([, id]) => !nodes.some(node => node.id === id)).map(([model, id]) => <div key={model} role="status" className="flex items-center justify-between gap-3 rounded border p-3 text-sm"><span>{model} · {t('ollama.unavailable')} ({id})</span><Button variant="outline" size="sm" onClick={async () => { try { await window.electronAPI.ollama.pinModel(model); await load() } catch (error) { setLoadError(String(error)) } }}>{t('ollama.unpin')}</Button></div>)}
      {!loading && !loadError && nodes.length === 0 ? (
        <Card>
          <CardContent className="p-6">
            <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed py-10 text-center text-sm text-muted-foreground">
              <Network className="h-8 w-8 opacity-50" />
              {t('ollama.empty')}
            </div>
          </CardContent>
        </Card>
      ) : nodes.map(node => {
        const isExpanded = expanded.has(node.id)
        const progress = modelProgress.find(item => item.providerId === node.id)
        const isTestingNode = node.id in activeTests || Boolean(progress)
        const isBusy = busy.has(node.id) || isTestingNode || importing || savingRouting
        const draft = authDrafts[node.id] || { type: node.authTypeLabel }
        return (
          <Card key={node.id} className="min-w-0 overflow-hidden" data-node-id={node.id} aria-busy={isBusy}>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <button aria-expanded={isExpanded} aria-controls={`node-details-${node.id}`} className="flex min-w-0 flex-1 items-start gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => toggleExpanded(node.id)}>
                  {isExpanded ? <ChevronDown className="mt-1 h-4 w-4" /> : <ChevronRight className="mt-1 h-4 w-4" />}
                  <div className="min-w-0">
                    <CardTitle title={node.name} className="break-words text-base">{node.name}</CardTitle>
                    <CardDescription className="mt-1 break-all">{node.apiEndpoint}</CardDescription>
                  </div>
                </button>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className={statusClass(node.status)}>
                    {t(`ollama.status.${node.status || 'unknown'}`)}
                  </Badge>
                  <Badge variant="outline">{t('ollama.modelCount', { count: node.modelCount })}</Badge>
                  <Switch
                    aria-label={t('ollama.enableNode', { name: node.name })}
                    disabled={isBusy}
                    checked={node.enabled}
                    onCheckedChange={enabled => void runBusy(node.id, async () => updateNode(await window.electronAPI.ollama.update(node.id, { enabled })))}
                  />
                  {isTestingNode ? <Button size="sm" variant="outline" disabled={stopping.has(node.id)} onClick={() => void cancelScans(node.id)}>{t('ollama.stopTests')}</Button> : null}
                  <Button aria-label={t('ollama.rescan')} title={t('ollama.rescan')} variant="outline" size="icon" disabled={isBusy} onClick={() => void runTest(node.id, '', async () => updateNode(await window.electronAPI.ollama.scan(node.id)))}>
                    <RefreshCw className={`h-4 w-4 ${isBusy ? 'animate-spin' : ''}`} />
                  </Button>
                  <Button aria-label={t('ollama.delete')} title={t('ollama.delete')} variant="destructive" size="icon" disabled={isBusy} onClick={() => setPendingDelete(node)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              {node.lastScanError ? <p className="break-words text-sm text-danger">{node.lastScanError}</p> : null}
              {node.status === 'offline' && node.modelCount > 0 ? <p className="text-sm text-muted-foreground">{t('ollama.cachedModelsHint')}</p> : null}
              {isTestingNode ? <p role="status" className="break-all text-sm text-muted-foreground">{progress?.total ? t('ollama.testProgress', { completed: progress.completed, total: progress.total, model: progress.model }) : t('ollama.scanning')}</p> : null}
              {node.imitationWarning ? <div role="alert" data-imitation-warning className="flex flex-wrap items-center gap-3 rounded-lg border border-danger/40 bg-danger/5 p-3 text-sm">
                <p className="min-w-0 flex-1 break-words"><strong className="text-danger">{t('ollama.imitation.title')}</strong> {t('ollama.imitation.body')}<span className="mt-1 block text-xs text-muted-foreground">{node.imitationWarning}</span></p>
                {node.enabled ? <Button size="sm" variant="destructive" disabled={isBusy} onClick={() => void runBusy(node.id, async () => updateNode(await window.electronAPI.ollama.update(node.id, { enabled: false })))}>{t('ollama.imitation.disable')}</Button> : null}
              </div> : null}
            </CardHeader>

            {isExpanded ? (
              <CardContent id={`node-details-${node.id}`} className="space-y-5">
                <div className="space-y-3 rounded-xl border bg-muted/25 p-4">
                  <Label>{t('ollama.authentication')}</Label>
                  <div className="grid gap-3 md:grid-cols-3">
                    <Select value={draft.type} disabled={isBusy} onValueChange={value => setAuthDrafts(current => ({ ...current, [node.id]: { type: value as OllamaAuthType } }))}>
                      <SelectTrigger aria-label={t('ollama.authentication')}><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">{t('ollama.auth.none')}</SelectItem>
                        <SelectItem value="basic">{t('ollama.auth.basic')}</SelectItem>
                        <SelectItem value="bearer">{t('ollama.auth.bearer')}</SelectItem>
                        <SelectItem value="api-key">{t('ollama.auth.apiKey')}</SelectItem>
                      </SelectContent>
                    </Select>
                    {draft.type === 'basic' ? (
                      <>
                        <Input aria-label={t('ollama.username')} disabled={isBusy} placeholder={t('ollama.username')} value={draft.username || ''} onChange={event => updateAuthDraft(node.id, { username: event.target.value })} />
                        <Input type="password" aria-label={t('ollama.password')} disabled={isBusy} placeholder={t('ollama.password')} value={draft.password || ''} onChange={event => updateAuthDraft(node.id, { password: event.target.value })} />
                      </>
                    ) : null}
                    {draft.type === 'bearer' ? (
                      <Input type="password" aria-label={t('ollama.token')} disabled={isBusy} placeholder={t('ollama.token')} value={draft.token || ''} onChange={event => updateAuthDraft(node.id, { token: event.target.value })} />
                    ) : null}
                    {draft.type === 'api-key' ? (
                      <>
                        <Input aria-label={t('ollama.headerName')} disabled={isBusy} placeholder={t('ollama.headerName')} value={draft.headerName || ''} onChange={event => updateAuthDraft(node.id, { headerName: event.target.value })} />
                        <Input type="password" aria-label={t('ollama.headerValue')} disabled={isBusy} placeholder={t('ollama.headerValue')} value={draft.headerValue || ''} onChange={event => updateAuthDraft(node.id, { headerValue: event.target.value })} />
                      </>
                    ) : null}
                  </div>
                  {node.authTypeLabel !== 'none' && draft.type === node.authTypeLabel ? <p className="text-xs text-muted-foreground">{t('ollama.authPreserved')}</p> : null}
                  <Button variant="outline" className="h-auto min-h-10 max-w-full whitespace-normal text-center" disabled={isBusy} onClick={() => void runTest(node.id, '', async () => {
                    const auth = Object.fromEntries(Object.entries(draft).filter(([key, value]) => key === 'type' || value !== '')) as AuthDraft
                    updateNode(await window.electronAPI.ollama.updateAuth(node.id, auth))
                    setAuthDrafts(current => ({ ...current, [node.id]: { type: auth.type } }))
                    updateNode(await window.electronAPI.ollama.scan(node.id))
                  })}>
                    {t('ollama.saveAuthAndScan')}
                  </Button>
                </div>

                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">{t('ollama.manualTestHint')}</p>
                  {Object.keys(node.ollamaModels || {}).length === 0 ? <p className="text-sm text-muted-foreground">{t('ollama.noModelDetails')}</p> : null}
                  {Object.values(node.ollamaModels || {}).map(model => {
                    const pinnedHere = pinnedModels.get(model.name) === node.id
                    const pinnedElsewhere = pinnedModels.has(model.name) && !pinnedHere
                    const usable = isOllamaModelUsable(node, model)
                    const modelEnabled = usable && !node.disabledModels.includes(model.name)
                    const isTesting = activeTests[node.id] === model.name || progress?.model === model.name
                    const testStatus = isTesting ? 'checking' : node.status === 'offline' ? 'offline' : model.testStatus || 'untested'
                    return (
                      <div key={model.name} data-model-name={model.name} className="flex flex-wrap items-center gap-2 rounded-lg border border-border/70 p-3 transition-colors hover:bg-muted/30">
                        <Switch
                          aria-label={t('ollama.enableModel', { name: model.name })}
                          checked={modelEnabled}
                          disabled={isBusy || !usable}
                          onCheckedChange={enabled => void runBusy(node.id, async () => {
                            updateNode(await window.electronAPI.ollama.setModelEnabled(node.id, model.name, enabled))
                          })}
                        />
                        <code className="mr-auto break-all font-mono text-sm">{model.name}</code>
                        <Badge variant="outline" className={NEUTRAL_PILL}>{model.endpoint || t('ollama.modelTest.untested')}</Badge>
                        <Badge role="status" data-model-test-status={testStatus} variant="outline" className={cn(testStatus === 'failed' ? DANGER_PILL : testStatus === 'passed' ? SUCCESS_PILL : NEUTRAL_PILL)}>
                          {t(`ollama.modelTest.${testStatus}`)}
                        </Badge>
                        {model.latency !== undefined ? <Badge variant="secondary" className="tabular-nums">{model.latency} ms</Badge> : null}
                        {model.testedAt ? <span className="text-xs text-muted-foreground">{t('ollama.lastTest', { time: new Date(model.testedAt).toLocaleString() })}</span> : null}
                        <Badge variant="outline" className={visionClass(model.vision)}>
                          <Eye className="mr-1 h-3 w-3" />
                          {t(`ollama.vision.${model.vision}`)}
                        </Badge>
                        <Button size="sm" variant="outline" aria-label={t('ollama.testModelNamed', { name: model.name })} disabled={isBusy} onClick={() => void runTest(node.id, model.name, async () => {
                          const metadata = await window.electronAPI.ollama.testModel(node.id, model.name)
                          setNodes(current => current.map(item => item.id === node.id ? {
                            ...item, ollamaModels: { ...(item.ollamaModels || {}), [model.name]: metadata },
                          } : item))
                        })}>
                          {isTesting ? <RefreshCw className="mr-1 h-3 w-3 animate-spin" /> : <Activity className="mr-1 h-3 w-3" />}
                          {t(isTesting ? 'ollama.modelTest.checking' : 'ollama.testModel')}
                        </Button>
                        <Button size="sm" variant="outline" disabled={isBusy} onClick={() => void runTest(node.id, model.name, async () => {
                          const metadata = await window.electronAPI.ollama.testVision(node.id, model.name)
                          setNodes(current => current.map(item => item.id === node.id ? {
                            ...item,
                            ollamaModels: { ...(item.ollamaModels || {}), [model.name]: metadata },
                          } : item))
                        })}>
                          {t('ollama.testVision')}
                        </Button>
                        <Button size="sm" variant={pinnedHere ? 'default' : 'outline'} disabled={isBusy || (!pinnedHere && (pinnedElsewhere || !modelEnabled || !node.enabled))} onClick={() => void runBusy(node.id, async () => {
                          await window.electronAPI.ollama.pinModel(model.name, pinnedHere ? undefined : node.id)
                          setConfig(await window.electronAPI.config.get())
                        })}>
                          {pinnedHere ? <Link2 className="mr-1 h-3 w-3" /> : <Pin className="mr-1 h-3 w-3" />}
                          {pinnedHere ? t('ollama.unpin') : pinnedElsewhere ? t('ollama.pinnedElsewhere') : t('ollama.pin')}
                        </Button>
                        {testStatus === 'failed' && model.error ? <p className="w-full break-words text-xs text-danger">{model.error}</p> : null}
                      </div>
                    )
                  })}
                </div>
              </CardContent>
            ) : null}
          </Card>
        )
      })}

      <OllamaLogMonitor nodes={nodes} />

      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={open => { if (!open) setPendingDelete(null) }}
        destructive
        title={t('ollama.delete')}
        description={pendingDelete ? t('ollama.deleteConfirm', { name: pendingDelete.name }) : undefined}
        confirmLabel={t('ollama.delete')}
        onConfirm={() => {
          const node = pendingDelete
          setPendingDelete(null)
          if (!node) return
          void runBusy(node.id, async () => {
            await window.electronAPI.ollama.delete(node.id)
            setNodes(current => current.filter(item => item.id !== node.id))
            setConfig(await window.electronAPI.config.get())
          })
        }}
      />
    </div>
  )
}

export default OllamaNodes
