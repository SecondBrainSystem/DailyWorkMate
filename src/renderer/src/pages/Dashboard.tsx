import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Activity, ArrowDownRight, ArrowUpRight, CheckCircle2, Clock3, RefreshCw, Radio, Zap } from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { useGuardedNavigate } from '@/components/layout/navigationGuard'
import { RecentActivity } from '@/components/dashboard/RecentActivity'
import { TokenUsageCard } from '@/components/dashboard/TokenUsageCard'
import { UsageTrendChart, UsageHeatmap } from '@/components/dashboard/UsageCharts'
import { useDashboardStore } from '@/stores/dashboardStore'
import { compactUsage, summarizeUsage, usageDays, usageDate } from '@/lib/usageMetrics'
import '@/components/dashboard/monitor.css'

export function Dashboard() {
  const { t, i18n } = useTranslation()
  const navigate = useGuardedNavigate()
  const { snapshot, activities, isLoading, error, activityError, lastUpdated, refreshData } = useDashboardStore()
  const [range, setRange] = useState(30)
  const [selectedModel, setSelectedModel] = useState<string | null>(null)
  const summary = useMemo(() => summarizeUsage(snapshot, range), [snapshot, range, lastUpdated])
  const history = useMemo(() => usageDays(snapshot, 91), [snapshot, lastUpdated])
  const model = summary.models.some(item => item.model === selectedModel) ? selectedModel : null
  useEffect(() => {
    const refresh = () => { if (!document.hidden) void refreshData() }
    refresh()
    const timer = window.setInterval(refresh, 10000)
    document.addEventListener('visibilitychange', refresh)
    window.addEventListener('focus', refresh)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', refresh); window.removeEventListener('focus', refresh) }
  }, [refreshData])
  const format = (value: number) => compactUsage(value, i18n.language)
  const trend = summary.tokenChange
  const TrendIcon = trend !== null && trend < 0 ? ArrowDownRight : ArrowUpRight
  return (
    <div className="token-monitor" aria-busy={isLoading} data-monitor-ready={!!snapshot}>
      <PageHeader icon={Radio} title={t('nav.monitor')} description={t('monitor.description')} actions={
        <button className="usage-refresh" onClick={() => void refreshData()} disabled={isLoading} aria-label={t('dashboard.refresh')}>
          <RefreshCw size={15} className={isLoading ? 'animate-spin' : ''} /><span>{t('dashboard.refresh')}</span>
        </button>
      } />
      <div className="usage-toolbar">
        <div className="usage-live" data-stale={!!error || !snapshot}><span className="usage-live-dot" />
          <strong>{error ? t('monitor.stale') : !snapshot ? t(isLoading ? 'common.loading' : 'monitor.waiting') : t('monitor.live')}</strong>
          <span>{lastUpdated ? new Date(lastUpdated).toLocaleTimeString(i18n.language) : '—'}</span>
        </div>
        <div className="usage-segmented" role="group" aria-label={t('monitor.period')}>
          {[7, 30, 90].map(days => <button key={days} aria-pressed={range === days} onClick={() => setRange(days)}>{t('monitor.range', { count: days })}</button>)}
        </div>
      </div>
      {!window.electronAPI && <p className="usage-notice" role="status">{t('dashboard.browserModeDesc')}</p>}
      {error && <div className="usage-notice" role="alert"><strong>{t(snapshot ? 'monitor.refreshFailed' : 'monitor.loadFailed')}</strong><span>{error}</span></div>}
      {snapshot && !summary.complete && <p className="usage-notice usage-history-notice" role="status">{t('monitor.partialHistory', { available: summary.availableDays, total: range })}</p>}
      <div className="usage-overview">
        <section className="usage-hero" aria-label={t('dashboard.totalTokens')}>
          <div className="usage-hero-label"><Zap size={16} />{t(summary.complete ? 'monitor.consumption' : 'monitor.knownConsumption')}<span>TOKENS</span></div>
          <div className="usage-total" data-token-total={summary.totalTokens} title={summary.totalTokens.toLocaleString(i18n.language)}>{summary.availableDays ? format(summary.totalTokens) : '—'}</div>
          <div className="usage-comparison">
            {!summary.canCompare ? <span>{t('monitor.comparisonUnavailable')}</span> : <>
              {trend !== null ? <span className="usage-change"><TrendIcon size={14} />{Math.abs(trend).toFixed(1)}%</span> : <span className="usage-change">{t(summary.totalTokens ? 'monitor.newActivity' : 'monitor.noActivity')}</span>}
              <span>{t('monitor.previousPeriod', { count: range })}</span>
            </>}
          </div>
          <div className="usage-hero-footer"><span>{summary.days[0]?.date} — {summary.days.at(-1)?.date}</span><strong>{summary.dailyAverage === null ? '—' : t(summary.complete ? 'monitor.perDay' : 'monitor.perKnownDay', { value: format(summary.dailyAverage) })}</strong></div>
        </section>
        <section className="usage-kpi"><Activity /><span>{t('dashboard.totalRequests')}</span><strong>{summary.availableDays ? format(summary.totalRequests) : '—'}</strong><small>{summary.availableDays ? t('monitor.failed', { count: summary.failedRequests }) : '—'}</small></section>
        <section className="usage-kpi"><CheckCircle2 /><span>{t('dashboard.successRate')}</span><strong>{summary.successRate === null ? '—' : summary.successRate.toFixed(1) + '%'}</strong><small>{t('monitor.active', { count: summary.activeDays })}</small></section>
        <section className="usage-kpi"><Clock3 /><span>{t('dashboard.avgResponseTime')}</span><strong>{summary.avgLatency === null ? '—' : (summary.avgLatency / 1000).toFixed(2)}<em>{summary.avgLatency === null ? '' : 's'}</em></strong><small>{t('monitor.completedRequests')}</small></section>
      </div>
      {snapshot && summary.complete && !summary.totalTokens && <div className="usage-empty-banner"><Zap size={18} /><div><strong>{t(summary.totalRequests ? 'monitor.tokensUnreported' : 'monitor.emptyTitle')}</strong><p>{t(summary.totalRequests ? 'monitor.tokensUnreportedHint' : 'monitor.emptyHint')}</p></div></div>}
      <div className="usage-chart-grid">
        <UsageTrendChart days={summary.days} model={model} />
        <TokenUsageCard totalTokens={summary.totalTokens} models={summary.models} selectedModel={model} onSelectModel={setSelectedModel} />
      </div>
      <div className="usage-bottom-grid">
        <div className="usage-history-column">
          <UsageHeatmap days={history} />
          <div className="usage-peak"><span>{t(summary.complete ? 'monitor.peak' : 'monitor.knownPeak')}</span><strong>{summary.peak ? format(summary.peak.tokens) + ' tokens' : '—'}</strong><span>{summary.peak ? usageDate(summary.peak.date, i18n.language) : ''}</span></div>
        </div>
        <div className="usage-recent">
          {activityError && <p className="usage-notice" role="alert">{t('monitor.logsFailed')} {activityError}</p>}
          <RecentActivity activities={activities} maxVisible={4} onItemClick={item => navigate('/monitor/requests?highlight=' + encodeURIComponent(item.id))} />
          <button className="usage-text-button" onClick={() => navigate('/monitor/requests')}>{t('monitor.viewLogs')} →</button>
        </div>
      </div>
      <p className="usage-footnote">{t('monitor.dataNote')}</p>
    </div>
  )
}
