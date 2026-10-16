import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Network, Play, Plus, Square, Trash2 } from 'lucide-react'
import { Card, CardContent, CardHeading } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { useProxyStore } from '@/stores/proxyStore'
import {
  getProxyListeners, listenerKey, listenerUrl, normalizeListenerHost,
  validateListenerHost, validateListenerPort,
  type ListenerEndpoint,
} from './listener-utils'

export function ProxyListeners() {
  const { t } = useTranslation()
  const { appConfig, proxyConfig, proxyStatus, saveAppConfig, startProxy, stopProxy, isLoading } = useProxyStore()
  const [host, setHost] = useState('127.0.0.1')
  const [port, setPort] = useState('11434')
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<{ host?: string; port?: string }>({})
  const [actionError, setActionError] = useState<string | null>(null)
  const primary = { host: appConfig?.proxyHost || proxyConfig.host, port: appConfig?.proxyPort ?? proxyConfig.port }
  const additional = appConfig?.additionalProxyListeners ?? []
  const listeners = getProxyListeners(primary, additional, proxyStatus)
  const disabled = busy || isLoading
  const storeError = (fallback: string) => useProxyStore.getState().error || t(fallback)

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setActionError(null)
    try {
      await action()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const addListener = async () => {
    const hostError = validateListenerHost(host)
    const portError = validateListenerPort(port)
    setErrors({ host: hostError && t(hostError), port: portError && t(portError) })
    if (hostError || portError) return
    const endpoint = { host: normalizeListenerHost(host), port: Number(port) }
    if (listeners.some(listener => listenerKey(listener) === listenerKey(endpoint))) {
      setErrors({ port: t('proxy.listenerAlreadyExists') })
      return
    }
    if (additional.length >= 32) {
      setActionError(t('proxy.listenerLimit'))
      return
    }
    await run(async () => {
      if (!await saveAppConfig({ additionalProxyListeners: [...additional, endpoint] })) {
        throw new Error(storeError('proxy.configSaveFailed'))
      }
      if (!await startProxy(endpoint.port, endpoint.host)) {
        throw new Error(`${t('proxy.listenerSavedStartFailed')} ${storeError('proxy.listenerStartFailed')}`)
      }
    })
  }

  const toggleListener = (endpoint: ListenerEndpoint, isRunning: boolean) => run(async () => {
    const success = isRunning
      ? await stopProxy(endpoint.port, endpoint.host)
      : await startProxy(endpoint.port, endpoint.host)
    if (!success) throw new Error(storeError(isRunning ? 'proxy.listenerStopFailed' : 'proxy.listenerStartFailed'))
  })

  const removeListener = (endpoint: ListenerEndpoint, isRunning: boolean) => run(async () => {
    if (isRunning && !await stopProxy(endpoint.port, endpoint.host)) {
      throw new Error(storeError('proxy.listenerStopFailed'))
    }
    const currentAdditional = useProxyStore.getState().appConfig?.additionalProxyListeners ?? []
    if (!await saveAppConfig({
      additionalProxyListeners: currentAdditional.filter(listener => listenerKey(listener) !== listenerKey(endpoint)),
    })) throw new Error(storeError('proxy.configSaveFailed'))
  })

  return (
    <Card>
      <CardHeading icon={Network} title={t('proxy.listenersTitle')} description={t('proxy.listenersDescription')} />
      <CardContent className="space-y-4">
        <div className="space-y-2">
          {listeners.map(listener => (
            <div key={listenerKey(listener)} data-proxy-listener={listenerKey(listener)} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="break-all text-sm">{listenerUrl(listener)}</code>
                  <Badge variant={listener.isRunning ? 'default' : 'secondary'}>
                    {t(listener.isRunning ? 'proxy.listenerRunning' : 'proxy.listenerStopped')}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t(listener.primary ? 'proxy.listenerPrimary' : listener.saved ? 'proxy.listenerAdditional' : 'proxy.listenerTemporary')}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" disabled={disabled} onClick={() => void toggleListener(listener, listener.isRunning)}>
                  {listener.isRunning ? <Square className="mr-1 h-3 w-3" /> : <Play className="mr-1 h-3 w-3" />}
                  {t(listener.isRunning ? 'proxy.listenerStop' : 'proxy.listenerStart')}
                </Button>
                {!listener.primary && (
                  <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void removeListener(listener, listener.isRunning)}
                    aria-label={t('proxy.listenerRemoveAddress', { address: listenerUrl(listener) })}>
                    <Trash2 className="mr-1 h-3 w-3" />{t('proxy.listenerRemove')}
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
        <form noValidate className="space-y-3 border-t pt-4" onSubmit={event => { event.preventDefault(); void addListener() }}>
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-start">
            <div className="space-y-2">
              <Label htmlFor="additional-proxy-host">{t('proxy.bindAddress')}</Label>
              <Input id="additional-proxy-host" value={host} disabled={disabled} placeholder="127.0.0.1"
                onChange={event => { setHost(event.target.value); setErrors(previous => ({ ...previous, host: undefined })) }}
                aria-invalid={!!errors.host} aria-describedby={errors.host ? 'additional-proxy-host-error' : undefined} />
              {errors.host && <p id="additional-proxy-host-error" className="text-xs text-destructive">{errors.host}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="additional-proxy-port">{t('proxy.listeningPort')}</Label>
              <Input id="additional-proxy-port" value={port} disabled={disabled} placeholder="11434" type="number" min={1} max={65535} step={1}
                onChange={event => { setPort(event.target.value); setErrors(previous => ({ ...previous, port: undefined })) }}
                aria-invalid={!!errors.port} aria-describedby={errors.port ? 'additional-proxy-port-error' : undefined} />
              {errors.port && <p id="additional-proxy-port-error" className="text-xs text-destructive">{errors.port}</p>}
            </div>
            <Button type="submit" disabled={disabled} className="sm:mt-7">
              <Plus className="mr-1 h-4 w-4" />{t('proxy.listenerAddStart')}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t('proxy.listenersHelp')}</p>
        </form>
        {actionError && <p role="alert" className="break-words text-sm text-destructive">{actionError}</p>}
      </CardContent>
    </Card>
  )
}
