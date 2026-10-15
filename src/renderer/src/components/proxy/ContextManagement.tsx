import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardHeading } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { SettingList, SettingRow } from '@/components/ui/setting-row'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/hooks/use-toast'
import { Layers } from 'lucide-react'

interface StrategyConfig {
  slidingWindow: {
    enabled: boolean
    maxMessages: number
  }
  tokenLimit: {
    enabled: boolean
    maxTokens: number
  }
  summary: {
    enabled: boolean
    keepRecentMessages: number
    summaryPrompt?: string
  }
}

interface ContextManagementConfigType {
  enabled: boolean
  strategies: StrategyConfig
  executionOrder: ('slidingWindow' | 'tokenLimit' | 'summary')[]
}

export function ContextManagement() {
  const { t } = useTranslation()
  const { toast } = useToast()

  const [config, setConfig] = useState<ContextManagementConfigType>({
    enabled: false,
    strategies: {
      slidingWindow: { enabled: true, maxMessages: 20 },
      tokenLimit: { enabled: false, maxTokens: 4000 },
      summary: { enabled: false, keepRecentMessages: 20 },
    },
    executionOrder: ['slidingWindow', 'tokenLimit', 'summary'],
  })

  const [hasChanges, setHasChanges] = useState(false)

  useEffect(() => {
    loadConfig()
  }, [])

  const loadConfig = async () => {
    try {
      const contextConfig = await window.electronAPI.contextManagement.getConfig()
      setConfig(contextConfig)
    } catch (error) {
      console.error('Failed to load context management config:', error)
      toast({
        title: t('common.error'),
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      })
    }
  }

  const handleConfigChange = (updates: Partial<ContextManagementConfigType>) => {
    setConfig(prev => ({ ...prev, ...updates }))
    setHasChanges(true)
  }

  const handleStrategyChange = (
    strategyKey: keyof StrategyConfig,
    updates: Partial<StrategyConfig[keyof StrategyConfig]>
  ) => {
    setConfig(prev => ({
      ...prev,
      strategies: {
        ...prev.strategies,
        [strategyKey]: {
          ...prev.strategies[strategyKey],
          ...updates,
        },
      },
    }))
    setHasChanges(true)
  }

  const saveConfig = async () => {
    try {
      await window.electronAPI.contextManagement.updateConfig(config)
      setHasChanges(false)
      toast({
        title: t('common.success'),
        description: t('contextManagement.configSaved'),
      })
    } catch (error) {
      toast({
        title: t('common.error'),
        description: t('contextManagement.configSaveFailed'),
        variant: 'destructive',
      })
    }
  }

  return (
    <Card>
      <CardHeading
        icon={Layers}
        title={t('contextManagement.title')}
        actions={hasChanges && (
          <Badge variant="secondary" className="text-xs">
            {t('proxy.unsaved')}
          </Badge>
        )}
      />
      <CardContent className="space-y-4">
        <SettingList>
          <SettingRow
            label={t('contextManagement.enableContextManagement')}
            htmlFor="context-enabled"
            description={t('contextManagement.enableContextManagementHint')}
          >
            <Switch
              id="context-enabled"
              checked={config.enabled}
              onCheckedChange={(checked) => handleConfigChange({ enabled: checked })}
            />
          </SettingRow>
        </SettingList>

        {config.enabled && (
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('contextManagement.strategyConfig')}
            </p>
            <SettingList>
              <SettingRow
                label={t('contextManagement.slidingWindow.title')}
                htmlFor="context-sliding-window"
                description={t('contextManagement.slidingWindow.description')}
              >
                <Switch
                  id="context-sliding-window"
                  checked={config.strategies.slidingWindow.enabled}
                  onCheckedChange={(checked) =>
                    handleStrategyChange('slidingWindow', { enabled: checked })
                  }
                />
              </SettingRow>
              {config.strategies.slidingWindow.enabled && (
                <div className="setting-row space-y-2 bg-muted/30">
                  <Label htmlFor="max-messages">{t('contextManagement.slidingWindow.maxMessages')}</Label>
                  <Input
                    id="max-messages"
                    type="number"
                    min={1}
                    max={100}
                    value={config.strategies.slidingWindow.maxMessages}
                    onChange={(e) =>
                      handleStrategyChange('slidingWindow', {
                        maxMessages: parseInt(e.target.value) || 20,
                      })
                    }
                    className="w-32"
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('contextManagement.slidingWindow.maxMessagesHint')}
                  </p>
                </div>
              )}

              <SettingRow
                label={t('contextManagement.tokenLimit.title')}
                htmlFor="context-token-limit"
                description={t('contextManagement.tokenLimit.description')}
              >
                <Switch
                  id="context-token-limit"
                  checked={config.strategies.tokenLimit.enabled}
                  onCheckedChange={(checked) =>
                    handleStrategyChange('tokenLimit', { enabled: checked })
                  }
                />
              </SettingRow>
              {config.strategies.tokenLimit.enabled && (
                <div className="setting-row space-y-2 bg-muted/30">
                  <Label htmlFor="max-tokens">{t('contextManagement.tokenLimit.maxTokens')}</Label>
                  <Input
                    id="max-tokens"
                    type="number"
                    min={100}
                    max={100000}
                    value={config.strategies.tokenLimit.maxTokens}
                    onChange={(e) =>
                      handleStrategyChange('tokenLimit', {
                        maxTokens: parseInt(e.target.value) || 4000,
                      })
                    }
                    className="w-32"
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('contextManagement.tokenLimit.maxTokensHint')}
                  </p>
                </div>
              )}

              <SettingRow
                label={t('contextManagement.summary.title')}
                htmlFor="context-summary"
                description={t('contextManagement.summary.description')}
              >
                <Switch
                  id="context-summary"
                  checked={config.strategies.summary.enabled}
                  onCheckedChange={(checked) =>
                    handleStrategyChange('summary', { enabled: checked })
                  }
                />
              </SettingRow>
              {config.strategies.summary.enabled && (
                <div className="setting-row space-y-4 bg-muted/30">
                  <div className="space-y-2">
                    <Label htmlFor="keep-recent">{t('contextManagement.summary.keepRecentMessages')}</Label>
                    <Input
                      id="keep-recent"
                      type="number"
                      min={1}
                      max={100}
                      value={config.strategies.summary.keepRecentMessages}
                      onChange={(e) =>
                        handleStrategyChange('summary', {
                          keepRecentMessages: parseInt(e.target.value) || 20,
                        })
                      }
                      className="w-32"
                    />
                    <p className="text-xs text-muted-foreground">
                      {t('contextManagement.summary.keepRecentMessagesHint')}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="summary-prompt">{t('contextManagement.summary.customPrompt')}</Label>
                    <Textarea
                      id="summary-prompt"
                      placeholder={t('contextManagement.summary.customPromptPlaceholder')}
                      value={config.strategies.summary.summaryPrompt || ''}
                      onChange={(e) =>
                        handleStrategyChange('summary', { summaryPrompt: e.target.value })
                      }
                      rows={3}
                    />
                    <p className="text-xs text-muted-foreground">
                      {t('contextManagement.summary.customPromptHint')}
                    </p>
                  </div>
                </div>
              )}
            </SettingList>
          </div>
        )}

        {hasChanges && (
          <div className="flex justify-end border-t pt-4">
            <Button onClick={saveConfig}>
              {t('common.save')}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
