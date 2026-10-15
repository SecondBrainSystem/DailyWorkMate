/**
 * Account Detail Component
 * Displays detailed account information and usage statistics
 */

import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardHeading } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/layout/PageHeader'
import { useToast } from '@/hooks/use-toast'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import {
  User,
  Clock,
  AlertCircle,
  CheckCircle2,
  XCircle,
  Calendar,
  BarChart3,
  Zap,
  RefreshCw,
  Edit,
  Trash2,
  ArrowLeft,
  TrendingUp,
  Coins
} from 'lucide-react'
import type { Account, AccountStatus, Provider } from '@/types/electron'
import { cn } from '@/lib/utils'

interface AccountDetailProps {
  account: Account
  provider: Provider | undefined
  onBack: () => void
  onEdit: () => void
  onDelete: () => void
  onValidate: () => Promise<void>
}

const statusConfig: Record<AccountStatus, {
  labelKey: string
  badge: string
  icon: typeof CheckCircle2
}> = {
  active: {
    labelKey: 'providers.active',
    badge: 'border-success/30 bg-success/10 text-success',
    icon: CheckCircle2,
  },
  inactive: {
    labelKey: 'providers.inactive',
    badge: 'border-border bg-muted text-muted-foreground',
    icon: Clock,
  },
  expired: {
    labelKey: 'providers.expired',
    badge: 'border-warning/30 bg-warning/10 text-warning',
    icon: AlertCircle,
  },
  error: {
    labelKey: 'common.error',
    badge: 'border-danger/30 bg-danger/10 text-danger',
    icon: XCircle,
  },
}

export function AccountDetail({
  account,
  provider,
  onBack,
  onEdit,
  onDelete,
  onValidate,
}: AccountDetailProps) {
  const { t, i18n } = useTranslation()
  const { toast } = useToast()
  const [isValidating, setIsValidating] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [credits, setCredits] = useState<{
    totalCredits: number
    usedCredits: number
    remainingCredits: number
    expiresAt?: number
  } | null>(null)
  const [isLoadingCredits, setIsLoadingCredits] = useState(false)
  const [trendData, setTrendData] = useState<{ date: string; total: number; info: number; warn: number; error: number }[]>([])

  useEffect(() => {
    const fetchTrendData = async () => {
      try {
        const trend = await window.electronAPI.logs.getAccountTrend(account.id, 7)
        setTrendData(trend)
      } catch (error) {
        console.error('Failed to fetch account trend:', error)
      }
    }
    fetchTrendData()
  }, [account.id])

  const isMiniMaxProvider = provider?.id === 'minimax'

  const config = statusConfig[account.status]
  const StatusIcon = config.icon

  const formatDate = (timestamp?: number) => {
    if (!timestamp) return '-'
    return new Date(timestamp).toLocaleString(i18n.language, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  const formatRelativeTime = (timestamp?: number) => {
    if (!timestamp) return t('providers.never')
    const now = Date.now()
    const diff = now - timestamp
    const minutes = Math.floor(diff / 60000)
    const hours = Math.floor(diff / 3600000)
    const days = Math.floor(diff / 86400000)

    if (minutes < 1) return t('providers.justNow')
    if (minutes < 60) return `${minutes} ${t('dashboard.minutes')}`
    if (hours < 24) return `${hours} ${t('dashboard.hours')}`
    return `${days}d`
  }

  const usagePercent = account.dailyLimit
    ? Math.min(100, ((account.todayUsed || 0) / account.dailyLimit) * 100)
    : 0

  const handleValidate = async () => {
    setIsValidating(true)
    try {
      await onValidate()
    } finally {
      setIsValidating(false)
    }
  }

  const handleDelete = async () => {
    await onDelete()
    setShowDeleteDialog(false)
  }

  const handleGetCredits = async () => {
    if (!isMiniMaxProvider) return

    setIsLoadingCredits(true)
    try {
      const result = await window.electronAPI.accounts.getCredits(account.id)
      setCredits(result)
    } catch (error) {
      console.error('Failed to get credits:', error)
      toast({
        title: t('common.error'),
        description: error instanceof Error ? error.message : t('providers.operationFailed'),
        variant: 'destructive',
      })
    } finally {
      setIsLoadingCredits(false)
    }
  }

  const stats = [
    {
      labelKey: 'dashboard.totalRequests',
      value: (account.requestCount || 0).toLocaleString(i18n.language),
      icon: BarChart3,
    },
    {
      labelKey: 'providers.usedToday',
      value: (account.todayUsed || 0).toLocaleString(i18n.language),
      subtitle: account.dailyLimit ? `${t('providers.dailyLimit')}: ${account.dailyLimit}` : undefined,
      icon: Zap,
    },
    {
      labelKey: 'providers.lastCheck',
      value: formatRelativeTime(account.lastValidatedAt),
      icon: Clock,
    },
    {
      labelKey: 'apiKeys.createdAt',
      value: formatDate(account.createdAt),
      icon: Calendar,
    },
  ]

  const hasTrend = trendData.length > 0 && trendData.some(d => d.total > 0)
  const maxTotal = Math.max(...trendData.map(d => d.total), 1)

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground" onClick={onBack}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t('common.back')}
        </Button>

        <PageHeader
          icon={User}
          title={
            <span className="flex flex-wrap items-center gap-2">
              {account.name}
              <Badge variant="outline" className={cn('text-xs', config.badge)}>
                <StatusIcon className="h-3 w-3" />
                {t(config.labelKey)}
              </Badge>
            </span>
          }
          description={
            <span className="flex flex-wrap items-center gap-x-2">
              <span>{provider?.name || t('providers.unknown')}</span>
              <span aria-hidden="true">·</span>
              <code className="font-mono text-xs" title={account.id}>ID {account.id.slice(0, 8)}</code>
              {account.email && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{account.email}</span>
                </>
              )}
            </span>
          }
          actions={
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={handleValidate}
                disabled={isValidating}
              >
                <RefreshCw className={cn('mr-2 h-4 w-4', isValidating && 'animate-spin')} />
                {isValidating ? t('oauth.validating') : t('providers.validateCredentials')}
              </Button>
              <Button variant="outline" size="sm" onClick={onEdit}>
                <Edit className="mr-2 h-4 w-4" />
                {t('common.edit')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => setShowDeleteDialog(true)}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                {t('common.delete')}
              </Button>
            </>
          }
        />
      </div>

      {account.status === 'error' && account.errorMessage && (
        <div role="alert" className="flex items-start gap-3 rounded-xl border border-danger/30 bg-danger/5 p-4">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-danger">{t('common.error')}</p>
            <p className="mt-1 break-words text-sm text-muted-foreground">{account.errorMessage}</p>
          </div>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map((stat) => {
          const Icon = stat.icon
          return (
            <Card key={stat.labelKey}>
              <CardContent className="p-5">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-[0.8125rem] font-medium leading-snug text-muted-foreground">{t(stat.labelKey)}</p>
                  <span className="card-heading-icon">
                    <Icon />
                  </span>
                </div>
                <p className="mt-2 text-xl font-semibold tabular-nums tracking-tight">{stat.value}</p>
                {stat.subtitle && (
                  <p className="mt-1 text-xs text-muted-foreground">{stat.subtitle}</p>
                )}
              </CardContent>
            </Card>
          )
        })}
      </div>

      {account.dailyLimit ? (
        <Card>
          <CardContent className="p-5">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm text-muted-foreground">{t('providers.usedToday')}</span>
              <span className="text-sm font-medium tabular-nums">
                {account.todayUsed || 0} / {account.dailyLimit}
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-secondary">
              <div
                className={cn(
                  'h-full rounded-full transition-all',
                  usagePercent >= 90 ? 'bg-danger' :
                  usagePercent >= 70 ? 'bg-warning' : 'bg-success'
                )}
                style={{ width: `${usagePercent}%` }}
              />
            </div>
            {usagePercent >= 90 && (
              <p className="mt-1 flex items-center gap-1 text-xs text-danger">
                <AlertCircle className="h-3 w-3" />
                {t('providers.nearLimit')}
              </p>
            )}
          </CardContent>
        </Card>
      ) : null}

      {isMiniMaxProvider && (
        <Card>
          <CardHeading
            icon={Coins}
            title={t('minimax.creditsInfo')}
            actions={
              <Button
                variant="outline"
                size="sm"
                onClick={handleGetCredits}
                disabled={isLoadingCredits}
              >
                <RefreshCw className={cn('mr-2 h-4 w-4', isLoadingCredits && 'animate-spin')} />
                {isLoadingCredits ? t('common.loading') : t('minimax.getCredits')}
              </Button>
            }
          />
          <CardContent>
            {credits ? (
              <div className="rounded-xl border bg-muted/30 p-4 text-center">
                <p className="mb-1 text-sm text-muted-foreground">{t('minimax.remainingCredits')}</p>
                <p className="text-3xl font-bold tabular-nums text-success">{credits.remainingCredits.toLocaleString(i18n.language)}</p>
                {credits.expiresAt && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t('minimax.creditResetsAt')}: {formatDate(credits.expiresAt)}
                  </p>
                )}
              </div>
            ) : (
              !isLoadingCredits && (
                <p className="py-2 text-sm text-muted-foreground">{t('common.noData')}</p>
              )
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeading icon={TrendingUp} title={t('dashboard.requestsTrend')} description={t('providers.last7days')} />
        <CardContent>
          <div className="flex h-32 items-end justify-between gap-2">
            {hasTrend ? (
              trendData.map((day, i) => {
                const date = new Date(day.date)
                const dayName = date.toLocaleDateString(i18n.language, { weekday: 'short' })
                const heightPercent = (day.total / maxTotal) * 100
                const displayHeight = day.total > 0 ? Math.max(heightPercent, 5) : 2

                return (
                  <div key={i} className="flex h-full flex-1 flex-col items-center">
                    <div className="flex w-full flex-1 items-end">
                      <div
                        className={cn(
                          'w-full rounded-t-md transition-colors',
                          day.total > 0 ? 'bg-primary/25 hover:bg-primary/45' : 'bg-muted'
                        )}
                        style={{ height: `${displayHeight}%` }}
                        title={`${dayName}: ${day.total} ${t('dashboard.totalRequests')}`}
                      />
                    </div>
                    <span className="mt-1 text-xs text-muted-foreground">{dayName}</span>
                  </div>
                )
              })
            ) : (
              Array.from({ length: 7 }).map((_, i) => {
                const day = new Date()
                day.setDate(day.getDate() - (6 - i))
                const dayName = day.toLocaleDateString(i18n.language, { weekday: 'short' })

                return (
                  <div key={i} className="flex h-full flex-1 flex-col items-center">
                    <div className="flex w-full flex-1 items-end">
                      <div
                        className="w-full rounded-t-md bg-muted"
                        style={{ height: '2%' }}
                      />
                    </div>
                    <span className="mt-1 text-xs text-muted-foreground">{dayName}</span>
                  </div>
                )
              })
            )}
          </div>
          <p className="mt-4 text-center text-xs text-muted-foreground">
            {hasTrend
              ? `${trendData.reduce((sum, d) => sum + d.total, 0)} ${t('dashboard.totalRequests')}`
              : t('common.noData')
            }
          </p>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={showDeleteDialog}
        onOpenChange={setShowDeleteDialog}
        destructive
        title={t('providers.deleteAccount')}
        description={`${t('providers.confirmDeleteAccount')} "${account.name}"`}
        confirmLabel={t('common.delete')}
        onConfirm={handleDelete}
      />
    </div>
  )
}

export default AccountDetail
