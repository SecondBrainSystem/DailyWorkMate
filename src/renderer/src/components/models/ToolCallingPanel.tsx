import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, CheckCircle2, FlaskConical, Settings2, Wrench, XCircle } from 'lucide-react'
import {
  DEFAULT_TOOL_CALLING_CONFIG,
  P0_TOOL_CLIENT_ADAPTERS,
  P0_TOOL_PROVIDER_SUPPORT,
  type ToolCallingConfig,
  type ToolCallingModeSetting,
  type ToolClientAdapterId,
} from '../../../../shared/toolCalling'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeading } from '@/components/ui/card'
import { SettingList, SettingRow } from '@/components/ui/setting-row'
import { cn } from '@/lib/utils'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useProxyStore } from '@/stores/proxyStore'
import { toast } from '@/hooks/use-toast'

function mergeToolCallingConfig(
  config: ToolCallingConfig,
  updates: Partial<ToolCallingConfig>,
): ToolCallingConfig {
  return {
    ...config,
    ...updates,
    advanced: {
      ...config.advanced,
      ...updates.advanced,
    },
    enabled: updates.mode === 'off' ? false : updates.enabled ?? config.enabled,
  }
}

export function ToolCallingPanel() {
  const { t } = useTranslation()
  const { appConfig, saveAppConfig } = useProxyStore()
  const [smokeStatus, setSmokeStatus] = useState<'not_run' | 'running' | 'pass' | 'failed'>('not_run')
  const config = appConfig?.toolCallingConfig ?? DEFAULT_TOOL_CALLING_CONFIG
  const clientAdapters = P0_TOOL_CLIENT_ADAPTERS.filter(
    (adapter) => adapter.id === 'standard-openai-tools' || adapter.id === 'cherry-studio-mcp',
  )

  const selectedClient = useMemo(
    () => clientAdapters.find((adapter) => adapter.id === config.clientAdapterId),
    [config.clientAdapterId],
  )

  const saveConfig = async (updates: Partial<ToolCallingConfig>) => {
    if (!appConfig) return false
    const saved = await saveAppConfig({ toolCallingConfig: mergeToolCallingConfig(config, updates) })
    if (!saved) {
      toast({ title: t('common.error'), description: t('common.saveFailed'), variant: 'destructive' })
    }
    return saved
  }

  // The template is edited locally and saved explicitly, not written to disk on every keystroke.
  const savedTemplate = config.advanced.customPromptTemplate ?? ''
  const [templateDraft, setTemplateDraft] = useState(savedTemplate)
  const [savingTemplate, setSavingTemplate] = useState(false)
  useEffect(() => { setTemplateDraft(savedTemplate) }, [savedTemplate])
  const templateDirty = templateDraft !== savedTemplate
  const saveTemplate = async () => {
    setSavingTemplate(true)
    try {
      await saveConfig({ advanced: { ...config.advanced, customPromptTemplate: templateDraft || undefined } })
    } finally {
      setSavingTemplate(false)
    }
  }

  const runSmoke = async () => {
    setSmokeStatus('running')
    try {
      const result = await window.electronAPI?.toolCalling?.runSmoke?.({
        clientAdapterId: config.clientAdapterId,
      })
      setSmokeStatus(result?.success ? 'pass' : 'failed')
    } catch {
      setSmokeStatus('failed')
    }
  }

  const enabled = config.enabled && config.mode !== 'off'

  return (
    <div className="space-y-4">
      <Card>
        <CardHeading
          icon={Wrench}
          title={t('toolCalling.title')}
          description={t('toolCalling.description')}
          actions={
            <Badge
              variant="outline"
              className={cn('gap-1', enabled ? 'border-success/30 bg-success/10 text-success' : 'text-muted-foreground')}
            >
              {enabled ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
              {enabled ? t('toolCalling.statusEnabled') : t('toolCalling.statusDisabled')}
            </Badge>
          }
        />
        <CardContent className="space-y-5">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="tool-calling-client">{t('toolCalling.clientType')}</Label>
              <Select
                value={config.clientAdapterId}
                onValueChange={(value) => saveConfig({ clientAdapterId: value as ToolClientAdapterId })}
              >
                <SelectTrigger id="tool-calling-client">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {clientAdapters.map((adapter) => (
                    <SelectItem key={adapter.id} value={adapter.id}>{adapter.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {selectedClient ? t(selectedClient.descriptionKey) : t('toolCalling.clients.unknown')}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="tool-calling-mode">{t('toolCalling.mode')}</Label>
              <Select
                value={config.mode}
                onValueChange={(value) => saveConfig({
                  mode: value as ToolCallingModeSetting,
                  enabled: value !== 'off',
                })}
              >
                <SelectTrigger id="tool-calling-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="off">{t('toolCalling.modes.off')}</SelectItem>
                  <SelectItem value="auto">{t('toolCalling.modes.auto')}</SelectItem>
                  <SelectItem value="force">{t('toolCalling.modes.force')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">{t('toolCalling.providerMatrix')}</p>
            <ul className="flex flex-wrap gap-2" aria-label={t('toolCalling.providerMatrix')}>
              {P0_TOOL_PROVIDER_SUPPORT.map((provider) => (
                <li
                  key={provider.providerId}
                  className="flex items-center gap-1.5 rounded-full border bg-muted/40 px-3 py-1 text-sm"
                  title={t('toolCalling.supported')}
                >
                  <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" />
                  {provider.label}
                </li>
              ))}
            </ul>
          </div>

          <SettingList>
            <SettingRow label={t('toolCalling.smoke.title')} description={t('toolCalling.smoke.description')}>
              <Badge
                variant="outline"
                className={cn(
                  smokeStatus === 'pass' && 'border-success/30 bg-success/10 text-success',
                  smokeStatus === 'failed' && 'border-danger/30 bg-danger/10 text-danger',
                )}
              >
                {t(`toolCalling.smoke.${smokeStatus}`)}
              </Badge>
              <Button variant="outline" size="sm" onClick={runSmoke} disabled={smokeStatus === 'running'}>
                <FlaskConical className="mr-2 h-4 w-4" />
                {t('toolCalling.smoke.run')}
              </Button>
            </SettingRow>
          </SettingList>
        </CardContent>
      </Card>

      <Card>
        <CardHeading
          icon={Settings2}
          title={t('toolCalling.advanced.title')}
          description={t('toolCalling.advanced.description')}
          actions={
            <Switch
              id="tool-calling-diagnostics"
              aria-label={t('toolCalling.advanced.title')}
              checked={config.diagnosticsEnabled}
              onCheckedChange={(diagnosticsEnabled) => saveConfig({ diagnosticsEnabled })}
            />
          }
        />
        {config.diagnosticsEnabled && (
          <CardContent className="space-y-4">
            <SettingList>
              <SettingRow
                label={t('toolCalling.advanced.promptPreview')}
                htmlFor="tool-calling-prompt-preview"
                description={t('toolCalling.advanced.promptPreviewDesc')}
              >
                <Switch
                  id="tool-calling-prompt-preview"
                  checked={config.advanced.promptPreviewEnabled}
                  onCheckedChange={(promptPreviewEnabled) => saveConfig({ advanced: { promptPreviewEnabled } })}
                />
              </SettingRow>
            </SettingList>
            <div className="space-y-2">
              <Label htmlFor="tool-calling-template">{t('toolCalling.advanced.customTemplate')}</Label>
              <Textarea
                id="tool-calling-template"
                className="min-h-[160px] font-mono text-xs"
                value={templateDraft}
                onChange={(event) => setTemplateDraft(event.target.value)}
                placeholder={t('toolCalling.advanced.customTemplatePlaceholder')}
              />
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" disabled={!templateDirty || savingTemplate} onClick={() => setTemplateDraft(savedTemplate)}>
                  {t('common.reset')}
                </Button>
                <Button size="sm" disabled={!templateDirty || savingTemplate} onClick={() => { void saveTemplate() }}>
                  {t('common.save')}
                </Button>
              </div>
            </div>
          </CardContent>
        )}
      </Card>
    </div>
  )
}
