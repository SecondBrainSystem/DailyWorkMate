import { useShallow } from 'zustand/react/shallow'
import { Card, CardContent, CardHeading } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SettingList, SettingRow } from '@/components/ui/setting-row'
import { useSettingsStore } from '@/stores/settingsStore'
import { PanelLeft, Type } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { DEFAULT_TYPOGRAPHY, type TypographySettings } from '../../../../shared/typography'

/** Theme and language are switched from the top bar; this tab holds the remaining display preferences. */
export function AppearanceSettings() {
  const { t } = useTranslation()
  const { theme, setTheme, language, setLanguage, sidebarCollapsed, setSidebarCollapsed, uiTypography, updateConfig, isSaving } = useSettingsStore(useShallow(state => ({ theme: state.theme, setTheme: state.setTheme, language: state.language, setLanguage: state.setLanguage, sidebarCollapsed: state.sidebarCollapsed, setSidebarCollapsed: state.setSidebarCollapsed, uiTypography: state.uiTypography, updateConfig: state.updateConfig, isSaving: state.isSaving })))

  return (
<div className="space-y-6">
      <Card><CardHeading icon={Type} title={t('settings.appearance')} /><CardContent className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-2">{t('settings.theme')}<Select value={theme} onValueChange={value => setTheme(value as 'light' | 'dark' | 'system')}><SelectTrigger aria-label={t('settings.theme')}><SelectValue /></SelectTrigger><SelectContent>{['light', 'dark', 'system'].map(value => <SelectItem key={value} value={value}>{t('theme.' + value)}</SelectItem>)}</SelectContent></Select></label>
        <label className="space-y-2">{t('settings.language')}<Select value={language} onValueChange={value => setLanguage(value as 'zh-CN' | 'en-US')}><SelectTrigger aria-label={t('settings.language')}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="zh-CN">中文</SelectItem><SelectItem value="en-US">English</SelectItem></SelectContent></Select></label>
      </CardContent></Card>
      <Card>
        <CardHeading icon={Type} title={t('settings.typography')} description={t('settings.typographyDescription')} />
        <CardContent className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2"><Label htmlFor="ui-font-size">{t('settings.fontSize')}</Label>
              <Select value={String(uiTypography.fontSize)} disabled={isSaving} onValueChange={value => { void updateConfig({ uiTypography: { ...uiTypography, fontSize: Number(value) } }) }}>
                <SelectTrigger id="ui-font-size" aria-label={t('settings.fontSize')}><SelectValue /></SelectTrigger>
                <SelectContent>{[14, 16, 18, 20, 22, 24].map(size => <SelectItem key={size} value={String(size)}>{size} px{size === 18 ? ' · ' + t('settings.fontDefault') : ''}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-2"><Label htmlFor="ui-font-family">{t('settings.fontFamily')}</Label>
              <Select value={uiTypography.fontFamily} disabled={isSaving} onValueChange={value => { void updateConfig({ uiTypography: { ...uiTypography, fontFamily: value as TypographySettings['fontFamily'] } }) }}>
                <SelectTrigger id="ui-font-family" aria-label={t('settings.fontFamily')}><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="readable">{t('settings.fontReadable')}</SelectItem><SelectItem value="system">{t('settings.fontSystem')}</SelectItem></SelectContent>
              </Select>
            </div>
            <div className="space-y-2"><Label htmlFor="ui-font-weight">{t('settings.fontWeight')}</Label>
              <Select value={String(uiTypography.fontWeight)} disabled={isSaving} onValueChange={value => { void updateConfig({ uiTypography: { ...uiTypography, fontWeight: Number(value) as 400 | 500 } }) }}>
                <SelectTrigger id="ui-font-weight" aria-label={t('settings.fontWeight')}><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="400">{t('settings.fontRegular')}</SelectItem><SelectItem value="500">{t('settings.fontMedium')}</SelectItem></SelectContent>
              </Select>
            </div>
          </div>
          <div className="rounded-xl border border-[var(--glass-border)] bg-[color-mix(in_srgb,var(--text-primary)_2%,transparent)] p-4" data-typography-preview><p className="text-base leading-relaxed">{t('settings.fontPreview')}</p><p className="mt-2 text-sm text-muted-foreground">Aa Bb 0123456789 · 中文阅读更清晰</p></div>
          <Button variant="outline" disabled={isSaving} onClick={() => { void updateConfig({ uiTypography: { ...DEFAULT_TYPOGRAPHY } }) }}>{t('settings.fontReset')}</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeading icon={PanelLeft} title={t('settings.sidebar')} />
        <CardContent>
          <SettingList>
            <SettingRow label={t('settings.sidebarCollapsed')} htmlFor="sidebar-collapsed" description={t('settings.sidebarCollapsedHelp')}>
              <Switch
                id="sidebar-collapsed"
                checked={sidebarCollapsed}
                onCheckedChange={setSidebarCollapsed}
              />
            </SettingRow>
          </SettingList>
        </CardContent>
      </Card>
    </div>
  )
}
