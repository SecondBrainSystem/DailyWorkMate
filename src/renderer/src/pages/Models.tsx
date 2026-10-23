import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { ArrowRight, Cpu, Database, Wrench } from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ModelList } from '@/components/models'
import { ToolCallingPanel } from '@/components/models/ToolCallingPanel'
import { ModelMappingConfig } from '@/components/proxy'
import { useProxyStore } from '@/stores/proxyStore'
import { useNavigationStore } from '@/stores/navigationStore'

export function Models() {
  const { t } = useTranslation()
  const fetchAppConfig = useProxyStore(state => state.fetchAppConfig)
  const [searchParams, setSearchParams] = useSearchParams()
  const tabFromUrl = searchParams.get('tab')
  const activeTab = tabFromUrl && ['list', 'mapping', 'prompts'].includes(tabFromUrl) ? tabFromUrl : 'list'
  const hasLoadedRef = useRef(false)

  useEffect(() => {
    if (hasLoadedRef.current) return
    hasLoadedRef.current = true
    fetchAppConfig()
  }, [fetchAppConfig])

  const handleTabChange = (value: string) => {
    if (value !== activeTab) useNavigationStore.getState().setPendingNavigation(() => setSearchParams({ tab: value }))
  }

  return (
    <div className="space-y-6">
      <PageHeader icon={Cpu} title={t('models.title')} description={t('models.description')} />

      <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full">
        <TabsList className="flex h-auto w-full flex-wrap">
          <TabsTrigger value="list" className="flex items-center gap-2 py-2">
            <Database className="h-4 w-4" />
            <span>{t('models.modelList')}</span>
          </TabsTrigger>
          <TabsTrigger value="mapping" className="flex items-center gap-2 py-2">
            <ArrowRight className="h-4 w-4" />
            <span>{t('models.modelMapping')}</span>
          </TabsTrigger>
          <TabsTrigger value="prompts" className="flex items-center gap-2 py-2">
            <Wrench className="h-4 w-4" />
            <span>{t('models.prompts')}</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="list" className="mt-6">
          <ModelList />
        </TabsContent>

        <TabsContent value="mapping" className="mt-6">
          <ModelMappingConfig />
        </TabsContent>

        <TabsContent value="prompts" className="mt-6">
          <ToolCallingPanel />
        </TabsContent>
      </Tabs>
    </div>
  )
}

export default Models
