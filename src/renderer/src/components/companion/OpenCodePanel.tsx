import { useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ErrorText } from '@/components/ui/error-text'
import type { OpenCodeFreeCatalogue, OpenCodeRuntimeStatus } from '@shared/companion'

const labels = {
  zh: {
    title: 'OpenCode 与免费模型', description: '管理助手聊天与工作模式使用的 OpenCode 和官方免费模型。',
    runtime: 'OpenCode V2 运行程序', installed: '当前版本', latest: '最新 V2 稳定版', missing: '未安装', unknown: '尚未检查',
    daily: '程序会每天检查一次 OpenCode V2 官方发布。点击安装后更新，正在进行的工作任务不会被中断。',
    checked: '最近检查', check: '检查更新', checking: '正在检查…', install: '安装最新版本', installing: '正在下载并验证…',
    current: '当前已是最新稳定版。', updated: 'OpenCode 已更新，下次工作任务将使用新版。',
    busy: '工作任务正在进行。请完成或停止任务后安装更新。', release: '查看 GitHub 版本源码',
    free: '官方免费模型', refresh: '刷新列表', refreshing: '正在刷新…', empty: '暂未获取到可用的官方免费模型。',
    freeNote: '官方免费服务可能限流，是否可用以实际请求为准。',
    workNote: '在助手聊天或工作模式上方的模型列表中选择这些模型，由 OpenCode 直接连接官方服务。',
    source: '来源：OpenCode 官方模型列表与 models.dev 定价信息', modelsUpdated: '模型列表更新',
    stale: '当前显示的是缓存列表，刷新后获取最新信息。', loading: '正在读取…', close: '关闭',
    tools: '支持工具调用', textOnly: '文字对话',
  },
  en: {
    title: 'OpenCode & free models', description: 'Manage OpenCode and official free models for companion chat and Work mode.',
    runtime: 'OpenCode V2 runtime', installed: 'Installed version', latest: 'Latest stable V2 version', missing: 'Not installed', unknown: 'Not checked',
    daily: 'The app checks official stable OpenCode V2 releases once a day. Install updates here when your workspace task has finished.',
    checked: 'Last checked', check: 'Check for updates', checking: 'Checking…', install: 'Install latest version', installing: 'Downloading and verifying…',
    current: 'The latest stable version is installed.', updated: 'OpenCode was updated. Your next workspace task will use it.',
    busy: 'A workspace task is running. Finish or stop it before installing an update.', release: 'Official version on GitHub',
    free: 'Official free models', refresh: 'Refresh list', refreshing: 'Refreshing…', empty: 'No official free models are available in the current list.',
    freeNote: 'Official free services may have rate limits. Availability depends on the actual request.',
    workNote: 'Choose these models in the model list above companion chat or Work mode to connect to the official service through OpenCode.',
    source: 'Source: OpenCode official model list and models.dev pricing', modelsUpdated: 'Model list updated',
    stale: 'Showing a cached list. Refresh to retrieve the latest information.', loading: 'Loading…', close: 'Close',
    tools: 'Tool calling', textOnly: 'Text chat',
  },
}

export function OpenCodePanel({ chinese, onClose, onUpdated, disabled }: {
  chinese: boolean; onClose: () => void; onUpdated?: () => void; disabled: boolean
}) {
  const copy = chinese ? labels.zh : labels.en
  const [runtime, setRuntime] = useState<OpenCodeRuntimeStatus | null>(null)
  const [catalogue, setCatalogue] = useState<OpenCodeFreeCatalogue | null>(null)
  const [runtimeAction, setRuntimeAction] = useState<'load' | 'check' | 'install' | null>('load')
  const [modelsLoading, setModelsLoading] = useState(true)
  const [runtimeError, setRuntimeError] = useState('')
  const [modelsError, setModelsError] = useState('')
  const [installed, setInstalled] = useState(false)
  const mounted = useRef(true)
  const message = (error: unknown) => error instanceof Error ? error.message : String(error)
  const date = (value: number | null | undefined) => value ? new Date(value).toLocaleString(chinese ? 'zh-CN' : 'en-US') : copy.unknown

  useEffect(() => {
    mounted.current = true
    let cancelled = false
    void Promise.allSettled([
      window.electronAPI.companion.openCodeStatus(),
      window.electronAPI.companion.openCodeModels(false),
    ]).then(([status, models]) => {
      if (cancelled) return
      if (status.status === 'fulfilled') setRuntime(status.value)
      else setRuntimeError(message(status.reason))
      if (models.status === 'fulfilled') setCatalogue(models.value)
      else setModelsError(message(models.reason))
      setRuntimeAction(null)
      setModelsLoading(false)
    })
    return () => { cancelled = true; mounted.current = false }
  }, [])

  useEffect(() => {
    if (!runtime?.checking && !runtime?.installing) return
    let cancelled = false
    const timer = setInterval(() => {
      void window.electronAPI.companion.openCodeStatus().then(status => {
        if (!cancelled) setRuntime(status)
      }).catch(error => { if (!cancelled) setRuntimeError(message(error)) })
    }, 1500)
    return () => { cancelled = true; clearInterval(timer) }
  }, [runtime?.checking, runtime?.installing])

  const refreshModels = async (notify = true) => {
    setModelsLoading(true)
    setModelsError('')
    try {
      const models = await window.electronAPI.companion.openCodeModels(true)
      if (!mounted.current) return
      setCatalogue(models)
      if (notify) onUpdated?.()
    } catch (error) { if (mounted.current) setModelsError(message(error)) }
    finally { if (mounted.current) setModelsLoading(false) }
  }
  const updateRuntime = async (install: boolean) => {
    if (install && disabled) return
    setRuntimeAction(install ? 'install' : 'check')
    setRuntimeError('')
    setInstalled(false)
    try {
      const status = await (install ? window.electronAPI.companion.installOpenCodeUpdate() : window.electronAPI.companion.checkOpenCodeUpdate())
      if (!mounted.current) return
      setRuntime(status)
      if (install && !status.error) {
        setInstalled(true)
        setRuntimeAction(null)
        onUpdated?.()
        await refreshModels(false)
      }
    } catch (error) { if (mounted.current) setRuntimeError(message(error)) }
    finally { if (mounted.current) setRuntimeAction(null) }
  }
  const installing = runtimeAction === 'install' || !!runtime?.installing
  const busy = runtimeAction !== null || !!runtime?.checking || installing
  const releaseUrl = runtime?.releaseUrl && /^https:\/\/github\.com\/anomalyco\/opencode\/tree\/v2\.\d+\.\d+$/.test(runtime.releaseUrl) ? runtime.releaseUrl : ''

  return <Dialog open onOpenChange={open => { if (!open && !installing) onClose() }}>
    <DialogContent className="companion-settings max-h-[88vh] max-w-2xl overflow-y-auto" onEscapeKeyDown={event => { if (installing) event.preventDefault() }} onPointerDownOutside={event => { if (installing) event.preventDefault() }}>
      <DialogHeader><DialogTitle>{copy.title}</DialogTitle><DialogDescription>{copy.description}</DialogDescription></DialogHeader>
      <section className="grid gap-3" aria-labelledby="opencode-runtime-heading" aria-busy={busy}>
        <h3 id="opencode-runtime-heading" className="font-medium">{copy.runtime}</h3>
        <dl className="grid grid-cols-2 gap-3 rounded-lg border p-3 text-sm">
          <div><dt className="text-[var(--text-muted)]">{copy.installed}</dt><dd className="mt-1 font-medium">{runtime?.currentVersion || (runtimeAction === 'load' ? copy.loading : runtime?.source === 'missing' ? copy.missing : copy.unknown)}</dd></div>
          <div><dt className="text-[var(--text-muted)]">{copy.latest}</dt><dd className="mt-1 font-medium">{runtime?.latestVersion || copy.unknown}</dd></div>
        </dl>
        <p className="text-sm text-[var(--text-muted)]">{copy.daily}</p>
        <p className="text-xs text-[var(--text-muted)]">{copy.checked}: {date(runtime?.checkedAt)}</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void updateRuntime(false)}>{runtimeAction === 'check' || runtime?.checking ? copy.checking : copy.check}</Button>
          <Button size="sm" disabled={disabled || busy || !runtime || (!runtime.updateAvailable && runtime.source !== 'missing')} onClick={() => void updateRuntime(true)}>{installing ? copy.installing : copy.install}</Button>
          {releaseUrl && <Button variant="link" size="sm" onClick={() => void window.electronAPI.app.openExternal(releaseUrl).catch(error => setRuntimeError(message(error)))}>{copy.release}</Button>}
        </div>
        {disabled && <p className="text-sm text-[var(--text-muted)]">{copy.busy}</p>}
        {installed && !runtimeError && <p role="status" className="text-sm text-success">{copy.updated}</p>}
        {!installed && runtime?.currentVersion && runtime.latestVersion && !runtime.updateAvailable && !runtime.error && <p role="status" className="text-sm text-[var(--text-muted)]">{copy.current}</p>}
        {(runtimeError || runtime?.error) && <p role="alert" className="break-words text-sm text-danger">{runtimeError || runtime?.error}</p>}
      </section>
      <section className="grid gap-3 border-t pt-4" aria-labelledby="opencode-models-heading" aria-busy={modelsLoading}>
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 id="opencode-models-heading" className="font-medium">{copy.free}</h3><Button size="sm" variant="outline" disabled={modelsLoading || installing} onClick={() => void refreshModels()}>{modelsLoading ? copy.refreshing : copy.refresh}</Button></div>
        <p className="text-sm text-[var(--text-muted)]">{copy.workNote}</p>
        {!!catalogue?.models.length && <ul className="max-h-52 divide-y overflow-y-auto rounded-lg border px-3">{catalogue.models.map(model => <li key={model.id} className="flex items-start justify-between gap-3 py-2 text-sm"><span className="min-w-0 break-words">{model.name}</span><span className="shrink-0 text-xs text-[var(--text-muted)]">{model.toolCall ? copy.tools : copy.textOnly}</span></li>)}</ul>}
        {!modelsLoading && !catalogue?.models.length && <p className="text-sm text-[var(--text-muted)]">{copy.empty}</p>}
        <p className="text-sm text-[var(--text-muted)]">{copy.freeNote}</p>
        <p className="text-xs text-[var(--text-muted)]">{copy.source}<br />{copy.modelsUpdated}: {date(catalogue?.updatedAt)}</p>
        {catalogue?.stale && <p role="status" className="text-xs text-warning">{copy.stale}</p>}
        {(modelsError || catalogue?.error) && <p role="alert" className="break-words text-sm text-danger"><ErrorText error={modelsError || catalogue?.error || ''} /></p>}
      </section>
      <div className="flex justify-end"><Button variant="outline" disabled={installing} onClick={onClose}>{copy.close}</Button></div>
    </DialogContent>
  </Dialog>
}
