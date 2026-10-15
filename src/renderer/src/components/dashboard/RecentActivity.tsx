import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardHeading } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { History, ChevronRight } from 'lucide-react'

export interface ActivityItem {
  id: string
  type: 'success' | 'error' | 'warning' | 'info'
  title: string
  description?: string
  timestamp: number
  providerName?: string
  modelName?: string
  latency?: number
  statusCode?: number
}

export interface RecentActivityProps {
  activities: ActivityItem[]
  onItemClick?: (item: ActivityItem) => void
  className?: string
  maxVisible?: number
}

const TYPE_STYLES: Record<ActivityItem['type'], { dot: string; badge: string }> = {
  success: { dot: 'bg-success', badge: 'border-success/30 bg-success/10 text-success' },
  error: { dot: 'bg-danger', badge: 'border-danger/30 bg-danger/10 text-danger' },
  warning: { dot: 'bg-warning', badge: 'border-warning/30 bg-warning/10 text-warning' },
  info: { dot: 'bg-primary', badge: 'border-primary/30 bg-primary/10 text-primary' },
}

export function RecentActivity({
  activities,
  onItemClick,
  className,
  maxVisible = 7,
}: RecentActivityProps) {
  const { t } = useTranslation()

  const formatTime = (timestamp: number) => {
    const now = Date.now()
    const diff = now - timestamp
    const minutes = Math.floor(diff / 60000)
    const hours = Math.floor(diff / 3600000)
    const days = Math.floor(diff / 86400000)

    if (minutes < 1) return t('dashboard.justNow')
    if (minutes < 60) return t('dashboard.minutesAgo', { count: minutes })
    if (hours < 24) return t('dashboard.hoursAgo', { count: hours })
    return t('dashboard.daysAgo', { count: days })
  }

  const formatLatency = (ms: number) => {
    if (ms < 1000) return `${ms}ms`
    return `${(ms / 1000).toFixed(2)}s`
  }

  const visibleActivities = activities.slice(0, maxVisible)

  const renderBody = (item: ActivityItem) => {
    const styles = TYPE_STYLES[item.type] ?? TYPE_STYLES.info
    return (
      <>
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className={cn('h-2 w-2 shrink-0 rounded-full', styles.dot)} aria-hidden="true" />
            <span className="truncate text-sm font-medium">{item.title}</span>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {item.statusCode && (
              <span className={cn('rounded-full border px-2 py-0.5 font-mono text-xs tabular-nums', styles.badge)}>
                {item.statusCode}
              </span>
            )}
            {onItemClick && <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />}
          </div>
        </div>
        {item.description && (
          <p className="mt-1 truncate pl-4 text-xs text-muted-foreground">{item.description}</p>
        )}
        <div className="mt-1 flex items-center gap-2 pl-4 text-xs text-muted-foreground">
          <span>{formatTime(item.timestamp)}</span>
          {item.providerName && (
            <>
              <span aria-hidden="true">·</span>
              <span className="truncate">{item.providerName}</span>
            </>
          )}
          {item.latency !== undefined && (
            <>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">{formatLatency(item.latency)}</span>
            </>
          )}
        </div>
      </>
    )
  }

  return (
    <Card className={cn('flex h-full flex-col', className)}>
      <CardHeading icon={History} title={t('dashboard.recentActivity')} />
      <CardContent className="min-h-0 flex-1">
        {activities.length === 0 ? (
          <div className="flex h-32 items-center justify-center rounded-xl border border-dashed text-sm text-muted-foreground">
            {t('dashboard.noActivity')}
          </div>
        ) : (
          <ul className="max-h-[26rem] space-y-2 overflow-y-auto pr-1">
            {visibleActivities.map((item) => (
              <li key={item.id}>
                {onItemClick ? (
                  <button
                    type="button"
                    onClick={() => onItemClick(item)}
                    className="block w-full rounded-lg border border-border/70 px-3 py-2.5 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                  >
                    {renderBody(item)}
                  </button>
                ) : (
                  <div className="rounded-lg border border-border/70 px-3 py-2.5">
                    {renderBody(item)}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
