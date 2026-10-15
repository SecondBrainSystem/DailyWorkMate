import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardHeading } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useProxyStore } from '@/stores/proxyStore'
import { useToast } from '@/hooks/use-toast'
import { Settings2, AlertCircle } from 'lucide-react'

interface AdvancedConfigProps {
  onConfigChange?: () => void
}

interface FormErrors {
  timeout?: string
  retryCount?: string
}

export function AdvancedConfig({ onConfigChange }: AdvancedConfigProps) {
  const { t } = useTranslation()
  const { proxyConfig, setProxyConfig, saveAppConfig, isLoading } = useProxyStore()
  const { toast } = useToast()
  
  const initialFormDataRef = useRef({
    timeout: (proxyConfig.timeout / 1000).toString(),
    retryCount: proxyConfig.retryCount.toString(),
  })

  const [formData, setFormData] = useState({
    timeout: (proxyConfig.timeout / 1000).toString(),
    retryCount: proxyConfig.retryCount.toString(),
  })
  
  const [errors, setErrors] = useState<FormErrors>({})
  const [hasChanges, setHasChanges] = useState(false)

  useEffect(() => {
    const newFormData = {
      timeout: (proxyConfig.timeout / 1000).toString(),
      retryCount: proxyConfig.retryCount.toString(),
    }
    setFormData(newFormData)
    initialFormDataRef.current = newFormData
  }, [])

  const validateTimeout = (value: string): string | undefined => {
    const timeout = parseInt(value, 10)
    if (isNaN(timeout)) return t('proxy.timeoutMustBeNumber')
    if (timeout < 1 || timeout > 300) return t('proxy.timeoutRangeError')
    return undefined
  }

  const validateRetryCount = (value: string): string | undefined => {
    const count = parseInt(value, 10)
    if (isNaN(count)) return t('proxy.retryCountMustBeNumber')
    if (count < 0 || count > 10) return t('proxy.retryCountRangeError')
    return undefined
  }

  const handleTimeoutChange = (value: string) => {
    setFormData(prev => ({ ...prev, timeout: value }))
    const error = validateTimeout(value)
    setErrors(prev => ({ ...prev, timeout: error }))
    setHasChanges(true)
    onConfigChange?.()
  }

  const handleRetryCountChange = (value: string) => {
    setFormData(prev => ({ ...prev, retryCount: value }))
    const error = validateRetryCount(value)
    setErrors(prev => ({ ...prev, retryCount: error }))
    setHasChanges(true)
    onConfigChange?.()
  }

  const handleSave = async () => {
    const timeoutError = validateTimeout(formData.timeout)
    const retryError = validateRetryCount(formData.retryCount)

    if (timeoutError || retryError) {
      setErrors({
        timeout: timeoutError,
        retryCount: retryError,
      })
      toast({
        title: t('proxy.validationFailed'),
        description: t('proxy.fixFormErrors'),
        variant: 'destructive',
      })
      return
    }

    const newProxyConfig = {
      timeout: parseInt(formData.timeout, 10) * 1000,
      retryCount: parseInt(formData.retryCount, 10),
    }

    setProxyConfig(newProxyConfig)

    const success = await saveAppConfig({
      requestTimeout: newProxyConfig.timeout,
      retryCount: newProxyConfig.retryCount,
    })

    if (success) {
      setHasChanges(false)
      toast({
        title: t('common.success'),
        description: t('proxy.advancedConfigUpdated'),
      })
    } else {
      toast({
        title: t('common.error'),
        description: t('proxy.configSaveFailed'),
        variant: 'destructive',
      })
    }
  }

  const handleReset = () => {
    setFormData(initialFormDataRef.current)
    setErrors({})
    setHasChanges(false)
  }

  const isValid = !errors.timeout && !errors.retryCount

  return (
    <Card>
      <CardHeading
        icon={Settings2}
        title={t('proxy.advancedConfig')}
        description={t('proxy.advancedConfigDesc')}
        actions={hasChanges && (
          <Badge variant="secondary" className="text-xs">
            {t('proxy.unsaved')}
          </Badge>
        )}
      />
      <CardContent className="space-y-5">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="timeout">{t('proxy.requestTimeout')}</Label>
            <Input
              id="timeout"
              type="number"
              placeholder="60"
              value={formData.timeout}
              onChange={(e) => handleTimeoutChange(e.target.value)}
              aria-invalid={!!errors.timeout}
              className={errors.timeout ? 'border-destructive' : ''}
            />
            {errors.timeout ? (
              <p className="flex items-center gap-1 text-xs text-destructive">
                <AlertCircle className="h-3 w-3" />
                {errors.timeout}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">{t('proxy.timeoutHelp')}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="retryCount">{t('proxy.retryCount')}</Label>
            <Input
              id="retryCount"
              type="number"
              placeholder="3"
              value={formData.retryCount}
              onChange={(e) => handleRetryCountChange(e.target.value)}
              aria-invalid={!!errors.retryCount}
              className={errors.retryCount ? 'border-destructive' : ''}
            />
            {errors.retryCount ? (
              <p className="flex items-center gap-1 text-xs text-destructive">
                <AlertCircle className="h-3 w-3" />
                {errors.retryCount}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">{t('proxy.retryCountHelp')}</p>
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
  )
}

export default AdvancedConfig
