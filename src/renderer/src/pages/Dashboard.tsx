import { useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Activity, CheckCircle, Clock, Users, RefreshCw, LayoutDashboard, AlertTriangle } from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/button'
import {
  StatsCard,
  ProviderStatusCard,
  RequestChart,
  RecentActivity,
  TokenUsageCard,
} from '@/components/dashboard'
import { useDashboardStore } from '@/stores/dashboardStore'
import { cn } from '@/lib/utils'

/**
 * The one place for request statistics. Proxy start/stop lives in the top bar,
 * and navigation shortcuts live in the sidebar, so neither is repeated here.
 */
export function Dashboard() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const {
    trendDays, setTrendDays,
    stats,
    providers,
    activities,
    chartData,
    isLoading,
    error,
    lastUpdated,
    refreshData,
  } = useDashboardStore()
  const hasLoadedRef = useRef(false)

  useEffect(() => {
    if (!hasLoadedRef.current) {
      hasLoadedRef.current = true
      refreshData()
    }
  }, [])

  useEffect(() => {
    const interval = setInterval(() => {
      useDashboardStore.getState().refreshData()
    }, 60000)

    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    if (!window.electronAPI?.proxy?.onStatusChanged) return
    return window.electronAPI.proxy.onStatusChanged((status) => {
      useDashboardStore.getState().setProxyStatus(status)
    })
  }, [])

  const handleActivityClick = useCallback((item: { id: string; type: string; title: string }) => {
    navigate('/logs?tab=request&highlight=' + item.id)
  }, [navigate])

  const isElectron = !!window.electronAPI

  return (
    <div className="space-y-6">
      <PageHeader
        icon={LayoutDashboard}
        title={t('dashboard.title')}
        description={t('dashboard.description')}
        actions={<>
          <select className="rounded border bg-background p-2 text-sm" aria-label={t('dashboard.requestTrend')} value={trendDays} onChange={event => setTrendDays(Number(event.target.value))}>{[7, 14, 30].map(days => <option key={days} value={days}>{days} {t('common.days')}</option>)}</select>
          {lastUpdated && (
            <span className="text-xs text-muted-foreground">
              {t('dashboard.lastUpdated')}: {new Date(lastUpdated).toLocaleTimeString()}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={refreshData}
            disabled={isLoading}
          >
            <RefreshCw className={cn('h-4 w-4 mr-2', isLoading && 'animate-spin')} />
            {t('dashboard.refresh')}
          </Button>
        </>}
      />

      {!isElectron && (
        <div className="flex items-start gap-3 rounded-xl border border-[color-mix(in_srgb,var(--warning)_35%,transparent)] bg-[color-mix(in_srgb,var(--warning)_8%,transparent)] p-4 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--warning)]" />
          <div>
            <p className="font-medium">{t('dashboard.browserMode')}</p>
            <p className="text-muted-foreground">{t('dashboard.browserModeDesc')}</p>
          </div>
        </div>
      )}

      {error && (
        <div role="alert" className="flex items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatsCard
          title={t('dashboard.totalRequests')}
          value={stats.totalRequests.toLocaleString()}
          icon={Activity}
          trend={{
            value: stats.requestsTrend,
            label: t('dashboard.todayVsYesterday'),
          }}
        />
        <StatsCard
          title={t('dashboard.successRate')}
          value={`${stats.successRate}%`}
          icon={CheckCircle}
          trend={{
            value: stats.successRateTrend,
            label: t('dashboard.todayVsYesterday'),
          }}
        />
        <StatsCard
          title={t('dashboard.avgResponseTime')}
          value={`${stats.avgLatency}ms`}
          icon={Clock}
          trend={{
            value: stats.latencyTrend,
            label: t('dashboard.todayVsYesterday'),
            higherIsBetter: false,
          }}
        />
        <StatsCard
          title={t('dashboard.activeAccountCount')}
          value={stats.activeAccounts}
          icon={Users}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <RequestChart data={chartData} className="lg:col-span-2" />
        <TokenUsageCard
          totalTokens={stats.totalTokens}
          modelTokenUsage={stats.modelTokenUsage}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2 items-stretch">
        <ProviderStatusCard providers={providers} />
        <RecentActivity
          activities={activities}
          onItemClick={handleActivityClick}
        />
      </div>
    </div>
  )
}
