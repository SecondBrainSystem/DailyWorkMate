import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardHeading } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { Server, Wifi, WifiOff, AlertCircle } from 'lucide-react'
import type { ProviderStatus } from '@/types/electron'

export interface ProviderStats {
  id: string
  name: string
  status: ProviderStatus
  requestCount: number
  successCount: number
  quotaUsed?: number
  quotaTotal?: number
  latency?: number
}

export interface ProviderStatusCardProps {
  providers: ProviderStats[]
  className?: string
}

const STATUS_STYLES: Record<string, { pill: string; dot: string }> = {
  online: { pill: 'border-success/30 bg-success/10 text-success', dot: 'bg-success' },
  offline: { pill: 'border-danger/30 bg-danger/10 text-danger', dot: 'bg-danger' },
  unknown: { pill: 'border-warning/30 bg-warning/10 text-warning', dot: 'bg-warning' },
}

export function ProviderStatusCard({ providers, className }: ProviderStatusCardProps) {
  const { t } = useTranslation()

  const getStatusIcon = (status: ProviderStatus) => {
    switch (status) {
      case 'online':
        return <Wifi className="h-3 w-3" />
      case 'offline':
        return <WifiOff className="h-3 w-3" />
      default:
        return <AlertCircle className="h-3 w-3" />
    }
  }

  const getStatusText = (status: ProviderStatus) => {
    switch (status) {
      case 'online':
        return t('providers.online')
      case 'offline':
        return t('providers.offline')
      default:
        return t('providers.unknown')
    }
  }

  const getSuccessRate = (success: number, total: number) => {
    if (total === 0) return 0
    return Math.round((success / total) * 100)
  }

  return (
    <Card className={cn('flex h-full flex-col', className)}>
      <CardHeading icon={Server} title={t('dashboard.providerStats')} />
      <CardContent className="min-h-0 flex-1">
        {providers.length === 0 ? (
          <div className="flex h-32 items-center justify-center rounded-xl border border-dashed text-sm text-muted-foreground">
            {t('providers.noProvidersFound')}
          </div>
        ) : (
          <ul className="max-h-[26rem] space-y-2 overflow-y-auto pr-1">
            {providers.map((provider) => {
              const successRate = getSuccessRate(provider.successCount, provider.requestCount)
              const styles = STATUS_STYLES[provider.status] ?? STATUS_STYLES.unknown

              return (
                <li
                  key={provider.id}
                  className="rounded-lg border border-border/70 px-3 py-2.5 transition-colors hover:bg-muted/40"
                >
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className={cn('h-2 w-2 shrink-0 rounded-full', styles.dot)} aria-hidden="true" />
                      <span className="truncate text-sm font-medium">{provider.name}</span>
                    </div>
                    <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium', styles.pill)}>
                      {getStatusIcon(provider.status)}
                      {getStatusText(provider.status)}
                    </span>
                  </div>
                  <dl className="grid grid-cols-3 gap-2 text-xs">
                    <div className="min-w-0">
                      <dt className="truncate text-muted-foreground">{t('dashboard.totalRequests')}</dt>
                      <dd className="font-medium tabular-nums">{provider.requestCount.toLocaleString()}</dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="truncate text-muted-foreground">{t('dashboard.successRate')}</dt>
                      <dd className={cn('font-medium tabular-nums', provider.requestCount > 0 && (successRate >= 90 ? 'text-success' : successRate >= 70 ? 'text-warning' : 'text-danger'))}>
                        {successRate}%
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="truncate text-muted-foreground">{t('providers.latency')}</dt>
                      <dd className="font-medium tabular-nums">{provider.latency ? `${provider.latency}ms` : '-'}</dd>
                    </div>
                  </dl>
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
