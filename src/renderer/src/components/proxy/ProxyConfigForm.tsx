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

interface ProxyConfigFormProps {
  onConfigChange?: () => void
}

interface FormErrors {
  port?: string
  host?: string
}

export function ProxyConfigForm({ onConfigChange }: ProxyConfigFormProps) {
  const { t } = useTranslation()
  const { proxyConfig, proxyStatus, setProxyConfig, saveAppConfig, startProxy, stopProxy, isLoading } = useProxyStore()
  const { toast } = useToast()

  const initialConfigRef = useRef({
    port: proxyConfig.port.toString(),
    host: proxyConfig.host,
  })

  const [formData, setFormData] = useState({
    port: proxyConfig.port.toString(),
    host: proxyConfig.host,
  })

  const [errors, setErrors] = useState<FormErrors>({})
  const [hasChanges, setHasChanges] = useState(false)
  const [showRestartDialog, setShowRestartDialog] = useState(false)
  const [isRestarting, setIsRestarting] = useState(false)

  useEffect(() => {
    const newFormData = {
      port: proxyConfig.port.toString(),
      host: proxyConfig.host,
    }
    setFormData(newFormData)
    initialConfigRef.current = newFormData
  }, [])

  const validatePort = (value: string): string | undefined => {
    const port = parseInt(value, 10)
    if (isNaN(port)) return t('proxy.portMustBeNumber')
    if (port < 1 || port > 65535) return t('proxy.portRangeError')
    if (port < 1024 && port !== 80 && port !== 443) {
      return t('proxy.portPrivilege')
    }
    return undefined
  }

  const validateHost = (value: string): string | undefined => {
    if (!value.trim()) return t('proxy.bindAddressEmpty')
    const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/
    const ipv6Regex = /^\[?[0-9a-fA-F:]+\]?$/
    const hostnameRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/

    if (!ipv4Regex.test(value) && !ipv6Regex.test(value) && !hostnameRegex.test(value) && value !== 'localhost') {
      return t('proxy.invalidIpOrHostname')
    }
    return undefined
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

    const newPort = parseInt(formData.port, 10)
    const newHost = formData.host
    const portOrHostChanged = newPort !== proxyConfig.port || newHost !== proxyConfig.host
    const isProxyRunning = proxyStatus?.isRunning

    if (portOrHostChanged && isProxyRunning) {
      setShowRestartDialog(true)
      return
    }

    await performSave(newPort, newHost)
  }

  const performSave = async (newPort: number, newHost: string) => {
    setProxyConfig({ port: newPort, host: newHost })

    const success = await saveAppConfig({
      proxyPort: newPort,
      proxyHost: newHost,
    })

    if (success) {
      setHasChanges(false)
      initialConfigRef.current = {
        port: newPort.toString(),
        host: newHost,
      }
      toast({
        title: t('common.success'),
        description: t('proxy.proxyConfigUpdated'),
      })
    } else {
      toast({
        title: t('common.error'),
        description: t('proxy.configSaveFailed'),
        variant: 'destructive',
      })
    }
  }

  const handleRestartAndSave = async () => {
    setIsRestarting(true)
    try {
      const newPort = parseInt(formData.port, 10)
      const newHost = formData.host

      await performSave(newPort, newHost)

      await stopProxy()

      await new Promise(resolve => setTimeout(resolve, 500))

      const success = await startProxy(newPort)

      if (success) {
        toast({
          title: t('common.success'),
          description: t('proxy.proxyRestarted'),
        })
      } else {
        toast({
          title: t('common.error'),
          description: t('proxy.proxyRestartFailed'),
          variant: 'destructive',
        })
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
          title={t('proxy.basicConfig')}
          description={t('proxy.basicConfigDesc')}
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
        title={t('proxy.restartRequired')}
        description={t('proxy.restartRequiredDesc')}
        confirmLabel={isRestarting ? t('proxy.restarting') : t('proxy.restartNow')}
        onConfirm={handleRestartAndSave}
      />
    </>
  )
}

export default ProxyConfigForm
