import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardHeading } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { SettingList, SettingRow } from '@/components/ui/setting-row'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { useToast } from '@/hooks/use-toast'
import { Settings2 } from 'lucide-react'

export function SessionManagement() {
  const { t } = useTranslation()
  const { toast } = useToast()

  const [config, setConfig] = useState<{
    mode: 'single'
    sessionTimeout: number
    maxMessagesPerSession: number
    deleteAfterTimeout: boolean
    maxSessionsPerAccount: number
  }>({
    mode: 'single',
    sessionTimeout: 30,
    maxMessagesPerSession: 50,
    deleteAfterTimeout: false,
    maxSessionsPerAccount: 3,
  })

  const [hasChanges, setHasChanges] = useState(false)

  useEffect(() => {
    loadConfig()
  }, [])

  const loadConfig = async () => {
    try {
      const sessionConfig = await window.electronAPI.session.getConfig()
      setConfig(sessionConfig)
    } catch (error) {
      console.error('Failed to load session config:', error)
      toast({
        title: t('common.error'),
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      })
    }
  }

  const handleConfigChange = (updates: Partial<typeof config>) => {
    setConfig(prev => ({ ...prev, ...updates }))
    setHasChanges(true)
  }

  const saveConfig = async () => {
    try {
      await window.electronAPI.session.updateConfig(config)
      setHasChanges(false)
      toast({
        title: t('common.success'),
        description: t('session.configSaved'),
      })
    } catch (error) {
      toast({
        title: t('common.error'),
        description: t('session.configSaveFailed'),
        variant: 'destructive',
      })
    }
  }

  return (
    <Card>
      <CardHeading
        icon={Settings2}
        title={t('session.sessionSettings')}
        actions={hasChanges && (
          <Badge variant="secondary" className="text-xs">
            {t('proxy.unsaved')}
          </Badge>
        )}
      />
      <CardContent className="space-y-4">
        <SettingList>
          <SettingRow label={t('session.deleteAfterChat')} htmlFor="delete-after-chat" description={t('session.deleteAfterChatHint')}>
            <Switch
              id="delete-after-chat"
              checked={config.deleteAfterTimeout}
              onCheckedChange={(checked) => handleConfigChange({ deleteAfterTimeout: checked })}
            />
          </SettingRow>
        </SettingList>

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
