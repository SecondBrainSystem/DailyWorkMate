import { Card, CardContent } from '@/components/ui/card'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { TrendingUp, TrendingDown, Minus, type LucideIcon } from 'lucide-react'

export interface StatsCardProps {
  title: string
  value: string | number
  icon: LucideIcon
  trend?: {
    value: number
    label?: string
    /** Set to false when a rise is bad news (e.g. latency). */
    higherIsBetter?: boolean
  }
  className?: string
}

export function StatsCard({ title, value, icon: Icon, trend, className }: StatsCardProps) {
  const { t } = useTranslation()
  const getTrendIcon = () => {
    if (!trend) return null
    if (trend.value > 0) return <TrendingUp className="h-3 w-3" />
    if (trend.value < 0) return <TrendingDown className="h-3 w-3" />
    return <Minus className="h-3 w-3" />
  }

  const getTrendColor = () => {
    if (!trend || trend.value === 0) return 'text-muted-foreground'
    const good = (trend.value > 0) === (trend.higherIsBetter ?? true)
    return good ? 'text-[var(--success)]' : 'text-[var(--error)]'
  }

  return (
    <Card className={cn('', className)}>
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-3">
          <p className="text-[0.8125rem] font-medium leading-snug text-muted-foreground">{title}</p>
          <span className="card-heading-icon">
            <Icon />
          </span>
        </div>
        <div className="mt-2 text-2xl font-bold tabular-nums tracking-tight">{value}</div><p className="mt-1 text-xs text-muted-foreground">{t('dashboard.allTime')}</p>
        {trend && (
          <div className="mt-1 flex items-center gap-1 text-xs">
            <span className={cn('flex items-center gap-1 font-medium', getTrendColor())}>
              {getTrendIcon()}
              {trend.value > 0 ? '+' : ''}
              {trend.value}%
            </span>
            {trend.label && <span className="text-muted-foreground">{trend.label}</span>}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
