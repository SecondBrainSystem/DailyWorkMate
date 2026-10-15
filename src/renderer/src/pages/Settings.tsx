import { useTranslation } from 'react-i18next'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  AppearanceSettings,
  GeneralSettings,
  DataManagement,
} from '@/components/settings'
import { Sun, Settings as SettingsIcon, Database } from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'

export function Settings() {
  const { t } = useTranslation()
  const tabs = [
    { value: 'appearance', icon: Sun, label: t('settings.appearance') },
    { value: 'general', icon: SettingsIcon, label: t('settings.generalSettings') },
    { value: 'data', icon: Database, label: t('settings.data') },
  ]

  return (
    <div className="space-y-6">
      <PageHeader icon={SettingsIcon} title={t('settings.title')} description={t('settings.description')} />

      <Tabs defaultValue="appearance" className="w-full">
        <TabsList className="grid w-full grid-cols-3 h-auto">
          {tabs.map(({ value, icon: Icon, label }) => (
            <TabsTrigger key={value} value={value} className="flex items-center gap-2 py-2">
              <Icon className="h-4 w-4" />
              <span className="hidden sm:inline">{label}</span>
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
      </Tabs>
    </div>
  )
}
