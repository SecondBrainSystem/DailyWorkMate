import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardHeading } from '@/components/ui/card'
import { RequestLogList } from '@/components/logs'
import { PageHeader } from '@/components/layout/PageHeader'
import { FileText } from 'lucide-react'
import { ApplicationLogs } from '@/components/logs/ApplicationLogs'
import { Button } from '@/components/ui/button'

export default function LogsPage() {
  const { t } = useTranslation()
  const [searchParams] = useSearchParams()
  const tabFromUrl = searchParams.get('tab')
  
  const [activeTab, setActiveTab] = useState(tabFromUrl === 'app' ? 'app' : 'request')
  
  useEffect(() => {
    if (tabFromUrl === 'request') {
      setActiveTab('request')
    }
  }, [tabFromUrl, setActiveTab])

  return (
    <div className="space-y-6">
      <PageHeader icon={FileText} title={t('logs.title')} description={t('logs.description')} />
      <div className="flex gap-2"><Button variant={activeTab === 'request' ? 'default' : 'outline'} onClick={() => setActiveTab('request')}>{t('logs.requestLogs')}</Button><Button variant={activeTab === 'app' ? 'default' : 'outline'} onClick={() => setActiveTab('app')}>{t('logs.appLogs')}</Button></div>

      <Card>
        <CardHeading icon={FileText} title={activeTab === 'request' ? t('logs.requestLogs') : t('logs.appLogs')} description={activeTab === 'request' ? t('logs.requestLogsHint') : t('logs.appLogsHint')} />
        <CardContent>
          {activeTab === 'request' ? <RequestLogList /> : <ApplicationLogs />}
        </CardContent>
      </Card>
    </div>
  )
}
