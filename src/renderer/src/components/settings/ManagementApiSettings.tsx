import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardHeading } from '@/components/ui/card'
import { SettingList, SettingRow } from '@/components/ui/setting-row'
import { toast } from '@/hooks/use-toast'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Copy, RefreshCw, AlertTriangle, Terminal, Check, Eye, EyeOff } from 'lucide-react'

interface ManagementApiConfig {
  enableManagementApi: boolean
  managementApiSecret: string
  managementApiPort?: number
}

export function ManagementApiSettings() {
  const { t } = useTranslation()
  const [config, setConfig] = useState<ManagementApiConfig>({
    enableManagementApi: false,
    managementApiSecret: '',
  })
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [showConfirmDialog, setShowConfirmDialog] = useState(false)
  const [copied, setCopied] = useState(false)
  const [proxyPort, setProxyPort] = useState<number>(11434)
  const [showSecret, setShowSecret] = useState(false) // 默认隐藏

  useEffect(() => {
    loadConfig()
  }, [])

  const loadConfig = async () => {
    try {
      const result = await window.electronAPI.managementApi.getConfig()
      if (result) {
        setConfig(result)
      }
      const appConfig = await window.electronAPI.config.get()
      if (appConfig?.proxyPort) {
        setProxyPort(appConfig.proxyPort)
      }
    } catch (error) {
      console.error('Failed to load management API config:', error)
    } finally {
      setIsLoading(false)
    }
  }

  const reportError = (error: unknown) => {
    toast({
      title: t('common.error'),
      description: error instanceof Error ? error.message : String(error),
      variant: 'destructive',
    })
  }

  const handleToggle = async (enabled: boolean) => {
    setIsSaving(true)
    try {
      if (enabled && !config.managementApiSecret) {
        const generated = await window.electronAPI.managementApi.generateSecret()
        setConfig(current => ({ ...current, managementApiSecret: generated }))
      }
      await window.electronAPI.managementApi.updateConfig({
        enableManagementApi: enabled,
      })
      setConfig(prev => ({ ...prev, enableManagementApi: enabled }))
    } catch (error) {
      console.error('Failed to update management API config:', error)
      reportError(error)
    } finally {
      setIsSaving(false)
    }
  }

  const handleCopy = async () => {
    if (!config.managementApiSecret) return
    try {
      await navigator.clipboard.writeText(config.managementApiSecret)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (error) {
      console.error('Failed to copy secret:', error)
      reportError(error)
    }
  }

  const handleGenerateNew = async () => {
    setIsGenerating(true)
    try {
      const newSecret = await window.electronAPI.managementApi.generateSecret()
      if (newSecret) {
        setConfig(prev => ({ ...prev, managementApiSecret: newSecret }))
      }
      setShowConfirmDialog(false)
    } catch (error) {
      console.error('Failed to generate new secret:', error)
      reportError(error)
    } finally {
      setIsGenerating(false)
    }
  }

  const maskSecret = (secret: string) => {
    if (!secret || secret.length < 12) return secret
    // 显示前 4 位和后 4 位，中间用 **** 隐藏
    return secret.slice(0, 4) + '****' + secret.slice(-4)
  }

  const apiEndpoint = `http://127.0.0.1:${proxyPort}/v0/management`

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-6">
          <p className="text-center text-muted-foreground">{t('common.loading')}</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <>
      <Card>
        <CardHeading icon={Terminal} title={t('settings.managementApi.title')} description={t('settings.managementApi.description')} />
        <CardContent className="space-y-5">
          <SettingList>
            <SettingRow label={t('settings.managementApi.enableToggle')} htmlFor="management-api-toggle" description={t('settings.managementApi.enableDescription')}>
              <Switch
                id="management-api-toggle"
                checked={config.enableManagementApi}
                onCheckedChange={handleToggle}
                disabled={isSaving}
              />
            </SettingRow>
          </SettingList>

          {config.enableManagementApi && (
            <>
              <div className="space-y-3">
                <div className="space-y-0.5">
                  <Label htmlFor="management-api-secret">{t('settings.managementApi.secretKey')}</Label>
                  <p className="text-[0.8125rem] text-muted-foreground">{t('settings.managementApi.secretKeyDescription')}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    id="management-api-secret"
                    type="text"
                    value={config.managementApiSecret ? (showSecret ? config.managementApiSecret : maskSecret(config.managementApiSecret)) : t('settings.managementApi.secretKeyPlaceholder')}
                    readOnly
                    className="min-w-0 flex-1 font-mono"
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => setShowSecret(!showSecret)}
                    disabled={!config.managementApiSecret}
                    title={showSecret ? t('settings.managementApi.hideSecret') : t('settings.managementApi.showSecret')}
                    aria-label={showSecret ? t('settings.managementApi.hideSecret') : t('settings.managementApi.showSecret')}
                  >
                    {showSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={handleCopy}
                    disabled={!config.managementApiSecret}
                    title={t('settings.managementApi.copySecret')}
                    aria-label={t('settings.managementApi.copySecret')}
                  >
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => setShowConfirmDialog(true)}
                    disabled={isGenerating}
                  >
                    <RefreshCw className={`h-4 w-4 mr-2 ${isGenerating ? 'animate-spin' : ''}`} />
                    {t('settings.managementApi.generateNew')}
                  </Button>
                </div>
                <Alert className="border-[color-mix(in_srgb,var(--warning)_35%,transparent)] bg-[color-mix(in_srgb,var(--warning)_7%,transparent)]">
                  <AlertTriangle className="h-4 w-4 !text-[var(--warning)]" />
                  <AlertDescription>{t('settings.managementApi.warning')}</AlertDescription>
                </Alert>
              </div>

              <div className="space-y-3 border-t pt-5">
                <div className="space-y-0.5">
                  <Label>{t('settings.managementApi.apiDocumentation')}</Label>
                  <p className="text-[0.8125rem] text-muted-foreground">{t('settings.managementApi.apiEndpoint')}</p>
                </div>
                <code className="block w-full rounded-lg bg-muted px-3 py-2 font-mono text-[0.8125rem] break-all">
                  {apiEndpoint}
                </code>
                <pre className="block w-full overflow-x-auto rounded-lg bg-muted px-3 py-2 font-mono text-[0.8125rem] whitespace-pre-wrap break-all">
{`# GET
curl -X GET "${apiEndpoint}/config" \\
  -H "Authorization: Bearer YOUR_SECRET_KEY"

# PUT
curl -X PUT "${apiEndpoint}/config" \\
  -H "Authorization: Bearer YOUR_SECRET_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"proxyPort": ${proxyPort}}'`}
                </pre>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={showConfirmDialog}
        onOpenChange={setShowConfirmDialog}
        destructive
        busy={isGenerating}
        title={t('settings.managementApi.generateNew')}
        description={t('settings.managementApi.generateConfirm')}
        onConfirm={handleGenerateNew}
      />
    </>
  )
}
