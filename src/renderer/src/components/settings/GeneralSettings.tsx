import { useShallow } from 'zustand/react/shallow'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeading } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SettingList, SettingRow } from '@/components/ui/setting-row'
import { useSettingsStore, OAuthProxyMode } from '@/stores/settingsStore'
import { Power, Globe, Gauge } from 'lucide-react'

export function GeneralSettings() {
  const { t } = useTranslation()
  const { autoStart, setAutoStart, autoStartProxy, setAutoStartProxy, minimizeToTray, setMinimizeToTray, oauthProxyMode, setOauthProxyMode, isSaving } = useSettingsStore(useShallow(state => ({ autoStart: state.autoStart, setAutoStart: state.setAutoStart, autoStartProxy: state.autoStartProxy, setAutoStartProxy: state.setAutoStartProxy, minimizeToTray: state.minimizeToTray, setMinimizeToTray: state.setMinimizeToTray, oauthProxyMode: state.oauthProxyMode, setOauthProxyMode: state.setOauthProxyMode, isSaving: state.isSaving })))
  // Chromium switches apply at launch, so this setting lives outside the store and needs a restart.
  const [gpuCompositing, setGpuCompositing] = useState<boolean | null>(null)
  const [launchedWith, setLaunchedWith] = useState<boolean | null>(null)
  const [renderError, setRenderError] = useState('')
  useEffect(() => {
    void window.electronAPI.app.getStartupOptions().then(value => { setGpuCompositing(value.gpuCompositing); setLaunchedWith(value.gpuCompositing) })
      .catch(error => setRenderError(error instanceof Error ? error.message : String(error)))
  }, [])
  const changeGpuCompositing = async (enabled: boolean) => {
    setRenderError('')
    try { setGpuCompositing((await window.electronAPI.app.setStartupOptions({ gpuCompositing: enabled })).gpuCompositing) }
    catch (error) { setRenderError(error instanceof Error ? error.message : String(error)) }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeading icon={Power} title={t('settings.startupAndWindow')} />
        <CardContent>
          <SettingList>
            <SettingRow label={t('settings.autoStart')} htmlFor="auto-start" description={t('settings.autoStartHelp')}>
              <Switch id="auto-start" checked={autoStart} onCheckedChange={setAutoStart} disabled={isSaving} />
            </SettingRow>
            <SettingRow label={t('settings.autoStartProxy')} htmlFor="auto-start-proxy" description={t('settings.autoStartProxyHelp')}>
              <Switch id="auto-start-proxy" checked={autoStartProxy} onCheckedChange={setAutoStartProxy} disabled={isSaving} />
            </SettingRow>
            <SettingRow label={t('settings.minimizeToTray')} htmlFor="minimize-tray" description={t('settings.minimizeToTrayHelp')}>
              <Switch id="minimize-tray" checked={minimizeToTray} onCheckedChange={setMinimizeToTray} disabled={isSaving} />
            </SettingRow>
          </SettingList>
        </CardContent>
      </Card>

      <Card>
        <CardHeading icon={Gauge} title={t('settings.performance')} />
        <CardContent>
          <SettingList>
            <SettingRow label={t('settings.gpuCompositing')} htmlFor="gpu-compositing" description={t('settings.gpuCompositingHelp')}>
              <Switch id="gpu-compositing" checked={!!gpuCompositing} onCheckedChange={enabled => { void changeGpuCompositing(enabled) }} disabled={gpuCompositing === null} />
            </SettingRow>
          </SettingList>
          {gpuCompositing !== null && launchedWith !== null && gpuCompositing !== launchedWith && <div role="status" className="mt-3 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
            {t('settings.restartToApply')}<Button size="sm" variant="outline" onClick={() => { void window.electronAPI.app.relaunch() }}>{t('settings.restartNow')}</Button>
          </div>}
          {renderError && <p role="alert" className="mt-3 text-sm text-destructive">{renderError}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeading icon={Globe} title={t('settings.networkProxy')} />
        <CardContent>
          <SettingList>
            <SettingRow label={t('settings.oauthProxyMode')} htmlFor="oauth-proxy-mode" description={t('settings.oauthProxyModeHelp')}>
              <Select
                value={oauthProxyMode}
                onValueChange={(value) => setOauthProxyMode(value as OAuthProxyMode)}
                disabled={isSaving}
              >
                <SelectTrigger id="oauth-proxy-mode" className="w-[11rem]">
                  <SelectValue placeholder={t('settings.oauthProxyMode')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="system">{t('settings.oauthProxySystem')}</SelectItem>
                  <SelectItem value="none">{t('settings.oauthProxyNone')}</SelectItem>
                </SelectContent>
              </Select>
            </SettingRow>
          </SettingList>
        </CardContent>
      </Card>
    </div>
  )
}
