import { useTranslation } from 'react-i18next'
import { Card, CardContent } from '@/components/ui/card'
import { RequestLogList } from '@/components/logs'
import { PageHeader } from '@/components/layout/PageHeader'
import { FileText } from 'lucide-react'
import { ApplicationLogs } from '@/components/logs/ApplicationLogs'

export default function LogsPage({ kind = 'request' }: { kind?: 'request' | 'app' }) {
  const { t } = useTranslation()

  return (
    <div className="space-y-6">
      <PageHeader icon={FileText} title={t(kind === 'request' ? 'logs.requestLogs' : 'logs.appLogs')} description={t(kind === 'request' ? 'logs.requestLogsHint' : 'logs.appLogsHint')} />

      <Card>
        <CardContent className="pt-6">
          {kind === 'request' ? <RequestLogList /> : <ApplicationLogs />}
        </CardContent>
      </Card>
    </div>
  )
}
