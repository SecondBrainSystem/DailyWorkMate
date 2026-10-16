import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardHeading } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useProxyStore } from '@/stores/proxyStore'
import { useToast } from '@/hooks/use-toast'
import { Server, AlertCircle } from 'lucide-react'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { getProxyListeners, listenerKey, normalizeListenerHost, validateListenerHost, validateListenerPort } from './listener-utils'

interface ProxyConfigFormProps {
  onConfigChange?: () => void
}

interface FormErrors {
  port?: string
  host?: string
}

export function ProxyConfigForm({ onConfigChange }: ProxyConfigFormProps) {
  const { t } = useTranslation()
  const { appConfig, proxyConfig, setProxyConfig, saveAppConfig, startProxy, stopProxy, isLoading } = useProxyStore()
  const { toast } = useToast()
  const savedPort = appConfig?.proxyPort ?? proxyConfig.port
  const savedHost = appConfig?.proxyHost || proxyConfig.host

  const initialConfigRef = useRef({
    port: savedPort.toString(),
    host: savedHost,
  })

  const [formData, setFormData] = useState({
    port: savedPort.toString(),
    host: savedHost,
  })

  const [errors, setErrors] = useState<FormErrors>({})
  const [hasChanges, setHasChanges] = useState(false)
  const [showRestartDialog, setShowRestartDialog] = useState(false)
  const [isRestarting, setIsRestarting] = useState(false)

  useEffect(() => {
    const newFormData = {
      port: savedPort.toString(),
      host: savedHost,
    }
    if (!hasChanges) setFormData(newFormData)
    initialConfigRef.current = newFormData
  }, [savedPort, savedHost])

  const validatePort = (value: string): string | undefined => {
    const error = validateListenerPort(value)
    return error ? t(error) : undefined
  }

  const validateHost = (value: string): string | undefined => {
    const error = validateListenerHost(value)
    return error ? t(error) : undefined
  }

  const handlePortChange = (value: string) => {
    setFormData(prev => ({ ...prev, port: value }))
    setErrors(prev => ({ ...prev, port: validatePort(value) }))
    setHasChanges(true)
    onConfigChange?.()
  }

  const handleHostChange = (value: string) => {
    setFormData(prev => ({ ...prev, host: value }))
    setErrors(prev => ({ ...prev, host: validateHost(value) }))
    setHasChanges(true)
    onConfigChange?.()
  }

  const handleSave = async () => {
    const portError = validatePort(formData.port)
    const hostError = validateHost(formData.host)

    if (portError || hostError) {
      setErrors({ port: portError, host: hostError })
      toast({
        title: t('proxy.validationFailed'),
        description: t('proxy.fixFormErrors'),
        variant: 'destructive',
      })
      return
    }

    const newPort = Number(formData.port)
    const newHost = normalizeListenerHost(formData.host)
    const portOrHostChanged = listenerKey({ port: newPort, host: newHost }) !== listenerKey({ port: savedPort, host: savedHost })
    const state = useProxyStore.getState()
    const isProxyRunning = getProxyListeners({ port: savedPort, host: savedHost }, [], state.proxyStatus)[0].isRunning

    if (portOrHostChanged && isProxyRunning && newPort === savedPort) {
      toast({ title: t('proxy.changePrimaryTitle'), description: t('proxy.samePortHostChange'), variant: 'destructive' })
      return
    }

    if (portOrHostChanged && isProxyRunning) {
      setShowRestartDialog(true)
      return
    }

    await performSave(newPort, newHost)
  }

  const performSave = async (newPort: number, newHost: string) => {
    const state = useProxyStore.getState()
    const previous = { port: state.appConfig?.proxyPort ?? state.proxyConfig.port, host: state.appConfig?.proxyHost || state.proxyConfig.host }
    const nextKey = listenerKey({ port: newPort, host: newHost })
    const additional = (state.appConfig?.additionalProxyListeners ?? []).filter(endpoint => listenerKey(endpoint) !== nextKey)
    const preservePrevious = nextKey !== listenerKey(previous)
      && getProxyListeners(previous, [], state.proxyStatus)[0].isRunning
      && !additional.some(endpoint => listenerKey(endpoint) === listenerKey(previous))
    const nextAdditional = preservePrevious ? [...additional, previous] : additional
    if (nextAdditional.length > 32) {
      toast({ title: t('common.error'), description: t('proxy.listenerLimit'), variant: 'destructive' })
      return false
    }

    const success = await saveAppConfig({
      proxyPort: newPort,
      proxyHost: newHost,
      additionalProxyListeners: nextAdditional,
    })

    if (success) {
      setProxyConfig({ port: newPort, host: newHost })
      setFormData({ port: newPort.toString(), host: newHost })
      setHasChanges(false)
      initialConfigRef.current = {
        port: newPort.toString(),
        host: newHost,
      }
      toast({
        title: t('common.success'),
        description: t(preservePrevious ? 'proxy.primaryChangedPreservingPrevious' : 'proxy.proxyConfigUpdated'),
      })
    } else {
      toast({
        title: t('common.error'),
        description: useProxyStore.getState().error || t('proxy.configSaveFailed'),
        variant: 'destructive',
      })
    }
    return success
  }

  const handleRestartAndSave = async () => {
    setIsRestarting(true)
    try {
      const newPort = Number(formData.port)
      const newHost = normalizeListenerHost(formData.host)
      const alreadyRunning = getProxyListeners({ port: newPort, host: newHost }, [], useProxyStore.getState().proxyStatus)[0].isRunning
      if (!alreadyRunning && !await startProxy(newPort, newHost)) {
        toast({
          title: t('common.error'),
          description: useProxyStore.getState().error || t('proxy.listenerStartFailed'),
          variant: 'destructive',
        })
        return
      }
      if (!await performSave(newPort, newHost) && !alreadyRunning) {
        if (!await stopProxy(newPort, newHost)) {
          toast({ title: t('common.error'), description: useProxyStore.getState().error || t('proxy.listenerStopFailed'), variant: 'destructive' })
        }
      }
    } finally {
      setIsRestarting(false)
      setShowRestartDialog(false)
    }
  }

  const handleReset = () => {
    setFormData(initialConfigRef.current)
    setErrors({})
    setHasChanges(false)
  }

  const isValid = !errors.port && !errors.host

  return (
    <>
      <Card>
        <CardHeading
          icon={Server}
          title={t('proxy.primaryConfigTitle')}
          description={t('proxy.primaryConfigDescription')}
          actions={hasChanges && (
            <Badge variant="secondary" className="text-xs">
              {t('proxy.unsaved')}
            </Badge>
          )}
        />
        <CardContent className="space-y-5">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="port">{t('proxy.listeningPort')}</Label>
              <Input
                id="port"
                type="number"
                min={1}
                max={65535}
                step={1}
                placeholder="11434"
                value={formData.port}
                onChange={(e) => handlePortChange(e.target.value)}
                aria-invalid={!!errors.port}
                className={errors.port ? 'border-destructive' : ''}
              />
              {errors.port ? (
                <p className="flex items-center gap-1 text-xs text-destructive">
                  <AlertCircle className="h-3 w-3" />
                  {errors.port}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">{t('proxy.portRange')}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="host">{t('proxy.bindAddress')}</Label>
              <Input
                id="host"
                placeholder="127.0.0.1"
                value={formData.host}
                onChange={(e) => handleHostChange(e.target.value)}
                aria-invalid={!!errors.host}
                className={errors.host ? 'border-destructive' : ''}
              />
              {errors.host ? (
                <p className="flex items-center gap-1 text-xs text-destructive">
                  <AlertCircle className="h-3 w-3" />
                  {errors.host}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">{t('proxy.bindAddressHelp')}</p>
              )}
            </div>
          </div>

          <div className="flex justify-end gap-2 border-t pt-4">
            <Button
              variant="outline"
              onClick={handleReset}
              disabled={!hasChanges || isLoading}
            >
              {t('common.reset')}
            </Button>
            <Button
              onClick={handleSave}
              disabled={!hasChanges || !isValid || isLoading}
            >
              {isLoading ? t('proxy.saving') : t('proxy.saveConfig')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={showRestartDialog}
        onOpenChange={setShowRestartDialog}
        busy={isRestarting}
        title={t('proxy.changePrimaryTitle')}
        description={t('proxy.changePrimaryDescription')}
        confirmLabel={isRestarting ? t('proxy.saving') : t('proxy.changePrimaryConfirm')}
        onConfirm={handleRestartAndSave}
      />
    </>
  )
}

export default ProxyConfigForm
