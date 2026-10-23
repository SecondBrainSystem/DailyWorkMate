import { useTranslation } from 'react-i18next'
import { lazy, Suspense } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  AppearanceSettings,
  GeneralSettings,
  DataManagement,
} from '@/components/settings'
import { Sun, Settings as SettingsIcon, Database, Info } from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
const About = lazy(() => import('./About').then(module => ({ default: module.About })))

export function Settings() {
  const { t } = useTranslation()
  const [params, setParams] = useSearchParams()
  const requested = params.get('tab') || 'appearance'
  const activeTab = ['appearance', 'general', 'data', 'about'].includes(requested) ? requested : 'appearance'
  const tabs = [
    { value: 'appearance', icon: Sun, label: t('settings.appearance') },
    { value: 'general', icon: SettingsIcon, label: t('settings.generalSettings') },
    { value: 'data', icon: Database, label: t('settings.data') },
    { value: 'about', icon: Info, label: t('nav.about') },
  ]

  return (
    <div className="space-y-6">
      <PageHeader icon={SettingsIcon} title={t('settings.title')} description={t('settings.description')} />

      <Tabs value={activeTab} onValueChange={value => setParams({ tab: value })} className="w-full">
        <TabsList className="flex w-full flex-wrap h-auto">
          {tabs.map(({ value, icon: Icon, label }) => (
            <TabsTrigger key={value} value={value} className="flex flex-1 items-center gap-2 py-2">
              <Icon className="h-4 w-4" />
              <span>{label}</span>
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="appearance" className="mt-6">
          <AppearanceSettings />
        </TabsContent>

        <TabsContent value="general" className="mt-6">
          <GeneralSettings />
        </TabsContent>

        <TabsContent value="data" className="mt-6">
          <DataManagement />
        </TabsContent>
        <TabsContent value="about" className="mt-6">
          <Suspense fallback={<p role="status">{t('common.loading')}</p>}><About /></Suspense>
        </TabsContent>
      </Tabs>
    </div>
  )
}
