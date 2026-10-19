import { useShallow } from 'zustand/react/shallow'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardHeading } from '@/components/ui/card'
import { SettingList, SettingRow } from '@/components/ui/setting-row'
import { CommitNumberInput } from '@/components/ui/commit-number-input'
import { Button } from '@/components/ui/button'
import { useSettingsStore, LogLevel } from '@/stores/settingsStore'
import { useToast } from '@/hooks/use-toast'
import { ChatHistoryStorage } from '@/lib/chatHistory'
import { errorMessage } from '@/lib/errors'
import { chatHistoryStorage } from '@/lib/chatHistory'
import { configurationBackup, readConfigurationBackup } from '../../../../shared/configBackup'
import { Database, Download, Upload, Trash2, RotateCcw, AlertTriangle, FileText } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'

export function DataManagement() {
  const { t } = useTranslation()
  const { logLevel, setLogLevel, logRetentionDays, setLogRetentionDays, config, updateConfig, isSaving } = useSettingsStore(useShallow(state => ({ logLevel: state.logLevel, setLogLevel: state.setLogLevel, logRetentionDays: state.logRetentionDays, setLogRetentionDays: state.setLogRetentionDays, config: state.config, updateConfig: state.updateConfig, isSaving: state.isSaving })))
  const { toast } = useToast()
  const [isExporting, setIsExporting] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const [isClearing, setIsClearing] = useState(false)
  const [isResetting, setIsResetting] = useState(false)

  const requestLogConfig = config?.requestLogConfig ?? {
    enabled: true,
    maxEntries: 200,
    includeBodies: false,
    maxBodyChars: 8000,
    redactSensitiveData: true,
  }

  const updateRequestLogConfig = async (
    updates: Partial<typeof requestLogConfig>,
  ) => {
    await updateConfig({
      requestLogConfig: {
        ...requestLogConfig,
        ...updates,
      },
    })
  }

  const handleExportConfig = async () => {
    setIsExporting(true)
    try {
      const config = {
        version: await window.electronAPI.app.getVersion(),
        exportedAt: new Date().toISOString(),
        config: configurationBackup(await window.electronAPI.config.get()),
      }
      const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `dailyworkmate-config-${new Date().toISOString().split('T')[0]}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      toast({
        title: t('common.success'),
        description: t('settings.exportSuccess'),
      })
    } catch {
      toast({
        title: t('common.error'),
        description: t('settings.exportFailed'),
        variant: 'destructive',
      })
    } finally {
      setIsExporting(false)
    }
  }

  const handleImportConfig = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    setIsImporting(true)
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error(t('settings.configurationTooLarge'))
      const text = await file.text()
      const config = readConfigurationBackup(JSON.parse(text))
      if (await updateConfig(config)) {
        toast({
          title: t('common.success'),
          description: t('settings.importSuccess'),
        })
      } else throw new Error('Invalid configuration')
    } catch {
      toast({
        title: t('common.error'),
        description: t('settings.importFailed'),
        variant: 'destructive',
      })
    } finally {
      setIsImporting(false)
      event.target.value = ''
    }
  }

  const handleClearCache = async () => {
    if (!window.confirm(t('settings.clearCache'))) return
    setIsClearing(true)
    try {
      sessionStorage.clear()
      await window.electronAPI.app.clearCache()
      toast({
        title: t('common.success'),
        description: t('settings.cacheCleared'),
      })
    } catch {
      toast({
        title: t('common.error'),
        description: t('settings.cacheClearFailed'),
        variant: 'destructive',
      })
    } finally {
      setIsClearing(false)
    }
  }

  const handleResetApp = async () => {
    setIsResetting(true)
    try {
      if (!window.electronAPI?.store?.clearAll) throw new Error('Application storage is unavailable')
      const status = await window.electronAPI.proxy.getStatus()
      if (status.isRunning && !await window.electronAPI.proxy.stop()) {
        throw new Error('Unable to stop the proxy before resetting')
      }
      await chatHistoryStorage.clear()
      await new ChatHistoryStorage('dailyworkmate.companion.history.v1').clear()
      await window.electronAPI.store.clearAll()
      localStorage.clear()
      sessionStorage.clear()
      
      toast({
        title: t('common.success'),
        description: t('settings.resetSuccess'),
      })
      setTimeout(() => {
        window.location.reload()
      }, 1500)
    } catch (error) {
      toast({
        title: t('common.error'),
        description: t('settings.resetFailed') + ': ' + errorMessage(error),
        variant: 'destructive',
      })
    } finally {
      setIsResetting(false)
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeading icon={FileText} title={t('settings.logSettings')} description={t('settings.logSettingsDesc')} />
        <CardContent className="space-y-4">
          <SettingList>
            <SettingRow label={t('settings.logLevel')} htmlFor="log-level" description={t('settings.logLevelHelp')}>
              <Select value={logLevel} onValueChange={(value) => setLogLevel(value as LogLevel)} disabled={isSaving || isResetting}>
                <SelectTrigger id="log-level" className="w-[9rem]">
                  <SelectValue placeholder={t('settings.selectLogLevel')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="debug">Debug</SelectItem>
                  <SelectItem value="info">Info</SelectItem>
                  <SelectItem value="warn">Warn</SelectItem>
                  <SelectItem value="error">Error</SelectItem>
                </SelectContent>
              </Select>
            </SettingRow>
            <SettingRow label={t('settings.logRetentionDays')} htmlFor="log-retention" description={t('settings.logRetentionHelp')}>
              <CommitNumberInput
                id="log-retention"
                min={1}
                max={365}
                className="w-[9rem]"
                value={logRetentionDays}
                disabled={isResetting}
                onCommit={setLogRetentionDays}
              />
            </SettingRow>
            <SettingRow label={t('settings.requestLogEnabled')} htmlFor="request-log-enabled" description={t('settings.requestLogEnabledHelp')}>
              <Switch disabled={isSaving || isResetting}
                id="request-log-enabled"
                checked={requestLogConfig.enabled}
                onCheckedChange={(checked) => {
                  void updateRequestLogConfig({ enabled: checked })
                }}
              />
            </SettingRow>
            {requestLogConfig.enabled ? (
              <>
                <SettingRow label={t('settings.requestLogMaxEntries')} htmlFor="request-log-max-entries" description={t('settings.requestLogMaxEntriesHelp')}>
                  <CommitNumberInput
                    id="request-log-max-entries"
                    min={0}
                    max={10000}
                    className="w-[9rem]"
                    value={requestLogConfig.maxEntries}
                    disabled={isResetting}
                    onCommit={(maxEntries) => updateRequestLogConfig({ maxEntries })}
                  />
                </SettingRow>
                <SettingRow label={t('settings.requestLogRedactSensitive')} htmlFor="request-log-redact" description={t('settings.requestLogRedactSensitiveHelp')}>
                  <Switch disabled={isSaving || isResetting}
                    id="request-log-redact"
                    checked={requestLogConfig.redactSensitiveData}
                    onCheckedChange={(checked) => {
                      void updateRequestLogConfig({ redactSensitiveData: checked })
                    }}
                  />
                </SettingRow>
                <SettingRow label={t('settings.requestLogIncludeBodies')} htmlFor="request-log-bodies" description={t('settings.requestLogIncludeBodiesHelp')}>
                  <Switch disabled={isSaving || isResetting}
                    id="request-log-bodies"
                    checked={requestLogConfig.includeBodies}
                    onCheckedChange={(checked) => {
                      void updateRequestLogConfig({
                        includeBodies: checked,
                        maxBodyChars: checked ? Math.max(requestLogConfig.maxBodyChars, 8000) : requestLogConfig.maxBodyChars,
                      })
                    }}
                  />
                </SettingRow>
                {requestLogConfig.includeBodies ? (
                  <SettingRow label={t('settings.requestLogMaxBodyChars')} htmlFor="request-log-max-body" description={t('settings.requestLogMaxBodyCharsHelp')}>
                    <CommitNumberInput
                      id="request-log-max-body"
                      min={0}
                      max={1000000}
                      className="w-[9rem]"
                      value={requestLogConfig.maxBodyChars}
                      disabled={isResetting}
                      onCommit={(maxBodyChars) => updateRequestLogConfig({ maxBodyChars })}
                    />
                  </SettingRow>
                ) : null}
              </>
            ) : null}
          </SettingList>
        </CardContent>
      </Card>

      <Card>
        <CardHeading icon={Database} title={t('settings.dataManagement')} description={t('settings.dataManagementDesc')} />
        <CardContent>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={handleExportConfig}
              disabled={isExporting}
              className="flex items-center gap-2"
            >
              <Download className="h-4 w-4" />
              {isExporting ? t('settings.exporting') : t('settings.exportConfig')}
            </Button>
            <div className="relative">
              <input
                type="file"
                accept=".json"
                onChange={handleImportConfig}
                aria-label={t('settings.importConfig')}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                disabled={isImporting}
              />
              <Button
                variant="outline"
                disabled={isImporting}
                className="flex items-center gap-2"
                tabIndex={-1}
              >
                <Upload className="h-4 w-4" />
                {isImporting ? t('settings.importing') : t('settings.importConfig')}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="border-destructive/30">
        <CardHeading
          icon={AlertTriangle}
          title={<span className="text-destructive">{t('settings.dangerZone')}</span>}
          description={t('settings.dangerZoneDesc')}
          className="[&_.card-heading-icon]:bg-destructive/10 [&_.card-heading-icon]:text-destructive"
        />
        <CardContent>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={handleClearCache}
              disabled={isClearing}
              className="flex items-center gap-2"
            >
              <Trash2 className="h-4 w-4" />
              {isClearing ? t('settings.clearing') : t('settings.clearCache')}
            </Button>
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="destructive" className="flex items-center gap-2">
                  <RotateCcw className="h-4 w-4" />
                  {t('settings.resetApp')}
                </Button>
              </DialogTrigger>
              <DialogContent onEscapeKeyDown={event => { if (isResetting) event.preventDefault() }} onPointerDownOutside={event => { if (isResetting) event.preventDefault() }}>
                <DialogHeader>
                  <DialogTitle>{t('settings.confirmReset')}</DialogTitle>
                  <DialogDescription>
                    {t('settings.confirmResetDesc')}
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <DialogClose asChild>
                    <Button variant="outline" disabled={isResetting || isSaving}>
                      {t('common.cancel')}
                    </Button>
                  </DialogClose>
                  <Button
                    variant="destructive"
                    onClick={handleResetApp}
                    disabled={isResetting || isSaving}
                  >
                    {isResetting ? t('settings.resetting') : t('settings.confirmReset')}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
