import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  ProxyConfigForm,
  LoadBalanceConfig,
  AdvancedConfig,
  SessionManagement,
} from '@/components/proxy'
import { ContextManagement } from '@/components/proxy/ContextManagement'
import { useProxyStore } from '@/stores/proxyStore'
import { Settings, Scale, Settings2, MessageSquare } from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { Skeleton } from '@/components/ui/skeleton'
import { ModelFeatureConfig } from '@/components/proxy/ModelFeatureConfig'

const TABS = ['basic', 'loadbalance', 'session', 'advanced'] as const
type ProxyTab = typeof TABS[number]

export function ProxySettings() {
  const { t } = useTranslation()
  const { fetchAppConfig, fetchProxyStatus } = useProxyStore()
  const [searchParams, setSearchParams] = useSearchParams()
  const requested = searchParams.get('tab')
  const activeTab: ProxyTab = TABS.includes(requested as ProxyTab) ? requested as ProxyTab : 'basic'
  const hasLoadedRef = useRef(false)
  // Forms copy the saved config when they mount, so they wait for it to load.
  const [configReady, setConfigReady] = useState(false)

  useEffect(() => {
    if (hasLoadedRef.current) return
    hasLoadedRef.current = true

    void fetchAppConfig().finally(() => setConfigReady(true))
    void fetchProxyStatus()
  }, [])

  const tabs = [
    { value: 'basic', icon: Settings, label: t('proxy.basicConfig') },
    { value: 'loadbalance', icon: Scale, label: t('proxy.loadBalancing') },
    { value: 'session', icon: MessageSquare, label: t('proxy.sessionsTab') },
    { value: 'advanced', icon: Settings2, label: t('proxy.advancedConfig') },
  ]

  return (
    <div className="space-y-6">
      <PageHeader icon={Settings2} title={t('proxy.title')} description={t('proxy.description')} />

      <Tabs value={activeTab} onValueChange={(value) => setSearchParams({ tab: value }, { replace: true })} className="w-full">
        <TabsList className="flex flex-wrap w-full gap-1 h-auto p-1">
          {tabs.map(({ value, icon: Icon, label }) => (
            <TabsTrigger key={value} value={value} className="flex items-center gap-2 py-2 px-3 flex-1 min-w-0">
              <Icon className="h-4 w-4 flex-shrink-0" />
              <span className="hidden md:inline truncate">{label}</span>
            </TabsTrigger>
          ))}
        </TabsList>

        {!configReady ? (
          <div className="mt-6 space-y-4" role="status" aria-label={t('common.loading')}>
            <Skeleton className="h-48 w-full rounded-xl" />
            <Skeleton className="h-32 w-full rounded-xl" />
          </div>
        ) : <>
        <TabsContent value="basic" className="mt-6 space-y-6">
          <ProxyConfigForm />
          <ModelFeatureConfig />
        </TabsContent>

        <TabsContent value="loadbalance" className="mt-6">
          <LoadBalanceConfig />
        </TabsContent>

        <TabsContent value="session" className="mt-6 space-y-6">
          <SessionManagement />
          <ContextManagement />
        </TabsContent>

        <TabsContent value="advanced" className="mt-6">
          <AdvancedConfig />
        </TabsContent>
        </>}
      </Tabs>
    </div>
  )
}

export default ProxySettings
