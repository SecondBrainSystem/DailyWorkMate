import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ErrorText } from '@/components/ui/error-text'
import { useIsChinese } from '@/hooks/useIsChinese'
import type { OpenCodeFreeCatalogue, OpenCodeRuntimeStatus } from '@shared/companion'

export function OpenCodePanel({ onClose, onUpdated, disabled }: {
  onClose: () => void; onUpdated?: () => void; disabled: boolean
}) {
  const { t } = useTranslation()
  const chinese = useIsChinese()
  const [runtime, setRuntime] = useState<OpenCodeRuntimeStatus | null>(null)
  const [catalogue, setCatalogue] = useState<OpenCodeFreeCatalogue | null>(null)
  const [runtimeAction, setRuntimeAction] = useState<'load' | 'check' | 'install' | null>('load')
  const [modelsLoading, setModelsLoading] = useState(true)
  const [runtimeError, setRuntimeError] = useState('')
  const [modelsError, setModelsError] = useState('')
  const [installed, setInstalled] = useState(false)
  const mounted = useRef(true)
  const message = (error: unknown) => error instanceof Error ? error.message : String(error)
  const date = (value: number | null | undefined) => value ? new Date(value).toLocaleString(chinese ? 'zh-CN' : 'en-US') : t('companion.opencode.unknown')

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
      <DialogHeader><DialogTitle>{t('companion.opencode.title')}</DialogTitle><DialogDescription>{t('companion.opencode.description')}</DialogDescription></DialogHeader>
      <section className="grid gap-3" aria-labelledby="opencode-runtime-heading" aria-busy={busy}>
        <h3 id="opencode-runtime-heading" className="font-medium">{t('companion.opencode.runtime')}</h3>
        <dl className="grid grid-cols-2 gap-3 rounded-lg border p-3 text-sm">
          <div><dt className="text-[var(--text-muted)]">{t('companion.opencode.installed')}</dt><dd className="mt-1 font-medium">{runtime?.currentVersion || (runtimeAction === 'load' ? t('companion.opencode.loading') : runtime?.source === 'missing' ? t('companion.opencode.missing') : t('companion.opencode.unknown'))}</dd></div>
          <div><dt className="text-[var(--text-muted)]">{t('companion.opencode.latest')}</dt><dd className="mt-1 font-medium">{runtime?.latestVersion || t('companion.opencode.unknown')}</dd></div>
        </dl>
        <p className="text-sm text-[var(--text-muted)]">{t('companion.opencode.daily')}</p>
        <p className="text-xs text-[var(--text-muted)]">{t('companion.opencode.checked')}: {date(runtime?.checkedAt)}</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void updateRuntime(false)}>{runtimeAction === 'check' || runtime?.checking ? t('companion.opencode.checking') : t('companion.opencode.check')}</Button>
          <Button size="sm" disabled={disabled || busy || !runtime || (!runtime.updateAvailable && runtime.source !== 'missing')} onClick={() => void updateRuntime(true)}>{installing ? t('companion.opencode.installing') : t('companion.opencode.install')}</Button>
          {releaseUrl && <Button variant="link" size="sm" onClick={() => void window.electronAPI.app.openExternal(releaseUrl).catch(error => setRuntimeError(message(error)))}>{t('companion.opencode.release')}</Button>}
        </div>
        {disabled && <p className="text-sm text-[var(--text-muted)]">{t('companion.opencode.busy')}</p>}
        {installed && !runtimeError && <p role="status" className="text-sm text-success">{t('companion.opencode.updated')}</p>}
        {!installed && runtime?.currentVersion && runtime.latestVersion && !runtime.updateAvailable && !runtime.error && <p role="status" className="text-sm text-[var(--text-muted)]">{t('companion.opencode.current')}</p>}
        {(runtimeError || runtime?.error) && <p role="alert" className="break-words text-sm text-danger">{runtimeError || runtime?.error}</p>}
      </section>
      <section className="grid gap-3 border-t pt-4" aria-labelledby="opencode-models-heading" aria-busy={modelsLoading}>
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 id="opencode-models-heading" className="font-medium">{t('companion.opencode.free')}</h3><Button size="sm" variant="outline" disabled={modelsLoading || installing} onClick={() => void refreshModels()}>{modelsLoading ? t('companion.opencode.refreshing') : t('companion.opencode.refresh')}</Button></div>
        <p className="text-sm text-[var(--text-muted)]">{t('companion.opencode.workNote')}</p>
        {!!catalogue?.models.length && <ul className="max-h-52 divide-y overflow-y-auto rounded-lg border px-3">{catalogue.models.map(model => <li key={model.id} className="flex items-start justify-between gap-3 py-2 text-sm"><span className="min-w-0 break-words">{model.name}</span><span className="shrink-0 text-xs text-[var(--text-muted)]">{model.toolCall ? t('companion.opencode.tools') : t('companion.opencode.textOnly')}</span></li>)}</ul>}
        {!modelsLoading && !catalogue?.models.length && <p className="text-sm text-[var(--text-muted)]">{t('companion.opencode.empty')}</p>}
        <p className="text-sm text-[var(--text-muted)]">{t('companion.opencode.freeNote')}</p>
        <p className="text-xs text-[var(--text-muted)]">{t('companion.opencode.source')}<br />{t('companion.opencode.modelsUpdated')}: {date(catalogue?.updatedAt)}</p>
        {catalogue?.stale && <p role="status" className="text-xs text-warning">{t('companion.opencode.stale')}</p>}
        {(modelsError || catalogue?.error) && <p role="alert" className="break-words text-sm text-danger"><ErrorText error={modelsError || catalogue?.error || ''} /></p>}
      </section>
      <div className="flex justify-end"><Button variant="outline" disabled={installing} onClick={onClose}>{t('companion.opencode.close')}</Button></div>
    </DialogContent>
  </Dialog>
}
