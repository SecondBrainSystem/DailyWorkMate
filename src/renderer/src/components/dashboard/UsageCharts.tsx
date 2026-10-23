import { useId, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Activity, CalendarDays } from 'lucide-react'
import { compactUsage, modelDayUsage, usageDate, type UsageDay } from '@/lib/usageMetrics'

export function UsageTrendChart({ days, model }: { days: UsageDay[]; model: string | null }) {
  const { t, i18n } = useTranslation()
  const [metric, setMetric] = useState<'tokens' | 'requests'>('tokens')
  const [active, setActive] = useState<number | null>(null)
  const gradient = useId()
  const svg = useRef<SVGSVGElement>(null)
  const values = days.map(day => day.available ? model ? modelDayUsage(day, model, metric) : day[metric] : null)
  const max = Math.max(1, ...values.map(value => value ?? 0))
  const x = (index: number) => 12 + index / Math.max(1, days.length - 1) * 676
  const y = (value: number) => 180 - value / max * 158
  const path = values.map((value, index) => value === null ? '' : `${index && values[index - 1] !== null ? 'L' : 'M'} ${x(index)} ${y(value)}`).join(' ')
  const area = values.map((value, index) => value === null ? '' : (
    `${index && values[index - 1] !== null ? 'L' : `M ${x(index)} 180 L`} ${x(index)} ${y(value)}` +
    (index === values.length - 1 || values[index + 1] === null ? ` L ${x(index)} 180 Z` : '')
  )).join(' ')
  const index = Math.min(active ?? days.length - 1, days.length - 1)
  const point = days[index]
  const keyboard = (event: KeyboardEvent<SVGSVGElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    setActive(event.key === 'Home' ? 0 : event.key === 'End' ? days.length - 1 : Math.max(0, Math.min(days.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1))))
  }
  return (
    <section className="usage-panel usage-trend" aria-label={t('monitor.trend')}>
      <div className="usage-panel-heading">
        <h2><Activity aria-hidden="true" />{t('monitor.trend')}</h2>
        <div className="usage-segmented" role="group" aria-label={t('monitor.chartMetric')}>
          {(['tokens', 'requests'] as const).map(value => <button key={value} aria-pressed={metric === value} onClick={() => setMetric(value)}>{t(`monitor.${value}`)}</button>)}
        </div>
      </div>
      <div className="usage-chart-readout" aria-live="polite">
        <strong>{point?.available ? (values[index] || 0).toLocaleString(i18n.language) : t('monitor.historyUnavailable')} {point?.available && <small>{t(`monitor.${metric}`)}</small>}</strong>
        <span>{point ? usageDate(point.date, i18n.language) : '—'} · {model || t('monitor.allModels')}</span>
      </div>
      <div className="usage-plot">
        <div className="usage-y-labels" aria-hidden="true">{[max, max / 2, 0].map((value, index) => <span key={index}>{compactUsage(Math.round(value), i18n.language)}</span>)}</div>
        <svg ref={svg} viewBox="0 0 700 204" preserveAspectRatio="none" role="img" tabIndex={0}
          aria-label={t('monitor.chartHint')} onKeyDown={keyboard} onFocus={() => setActive(days.length - 1)}
          onPointerMove={event => {
            const bounds = svg.current?.getBoundingClientRect()
            if (bounds) setActive(Math.max(0, Math.min(days.length - 1, Math.round(((event.clientX - bounds.left) / bounds.width * 700 - 12) / 676 * (days.length - 1)))))
          }} onPointerLeave={() => setActive(null)} onBlur={() => setActive(null)}>
          <defs><linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--usage-accent)" stopOpacity="0.35" /><stop offset="100%" stopColor="var(--usage-accent)" stopOpacity="0.01" /></linearGradient></defs>
          {[0, 0.5, 1].map(fraction => <line key={fraction} x1="12" x2="688" y1={y(max * fraction)} y2={y(max * fraction)} stroke="var(--glass-border-hover)" strokeDasharray="3 6" vectorEffect="non-scaling-stroke" />)}
          {values.length > 0 && <><path d={area} fill={`url(#${gradient})`} /><path data-usage-series d={path} fill="none" stroke="var(--usage-accent)" strokeWidth="2.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" /></>}
          {values.map((value, index) => value !== null && (index === 0 || values[index - 1] === null) && (index === values.length - 1 || values[index + 1] === null) && <circle key={index} cx={x(index)} cy={y(value)} r="2" fill="var(--usage-accent)" />)}
          {point?.available && <><line x1={x(index)} x2={x(index)} y1="14" y2="180" stroke="var(--usage-accent)" strokeOpacity="0.4" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" /><circle cx={x(index)} cy={y(values[index] ?? 0)} r="4" fill="var(--usage-accent)" stroke="var(--bg-secondary)" strokeWidth="2" vectorEffect="non-scaling-stroke" /></>}
        </svg>
      </div>
      <div className="usage-x-labels">{[0, Math.floor(days.length / 2), days.length - 1].map(index => <span key={index}>{days[index] && usageDate(days[index].date, i18n.language, true)}</span>)}</div>
      <p className="usage-caption">{t(model ? 'monitor.filteredChart' : 'monitor.dailyTotals')}</p>
      {days.some(day => !day.available) && <p className="usage-caption">{t('monitor.chartGaps')}</p>}
    </section>
  )
}

export function UsageHeatmap({ days }: { days: UsageDay[] }) {
  const { t, i18n } = useTranslation()
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const selected = days.find(day => day.date === selectedDate) || days[days.length - 1]
  const max = Math.max(1, ...days.map(day => day.tokens))
  const leading = days.length ? (new Date(days[0].date + 'T12:00:00').getDay() + 6) % 7 : 0
  const cells = useRef<HTMLDivElement>(null)
  const activeDays = days.filter(day => day.tokens || day.requests).length
  const availableDays = days.filter(day => day.available).length
  const level = (tokens: number) => tokens === 0 ? 0 : Math.min(4, Math.max(1, Math.ceil(tokens / max * 4)))
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const offsets: Record<string, number> = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1, Home: -index, End: days.length - 1 - index }
    if (!(event.key in offsets)) return
    event.preventDefault()
    const next = Math.max(0, Math.min(days.length - 1, index + offsets[event.key]))
    setSelectedDate(days[next].date)
    cells.current?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus()
  }
  return (
    <section className="usage-panel usage-heatmap" aria-label={t('monitor.activity')}>
      <div className="usage-panel-heading"><h2><CalendarDays aria-hidden="true" />{t('monitor.activity')}</h2><span className="usage-caption">{t('monitor.weeks')}</span></div>
      <div className="usage-heatmap-summary"><strong>{activeDays}<small> / {availableDays}</small></strong><span>{t('monitor.activeDays')}</span></div>
      {availableDays < days.length && <p className="usage-caption">{t('monitor.historyCoverage', { available: availableDays, total: days.length })}</p>}
      <div className="usage-calendar" ref={cells} role="group" aria-label={t('monitor.heatmapHint')}>
        {Array.from({ length: leading }, (_, index) => <span key={`blank-${index}`} />)}
        {days.map((day, index) => <button key={day.date} className={`usage-cell ${day.available ? `level-${level(day.tokens)}${day.requests && !day.tokens ? ' has-requests' : ''}` : 'is-unavailable'}`}
          aria-pressed={selected?.date === day.date} tabIndex={selected?.date === day.date ? 0 : -1}
          aria-label={day.available ? `${day.date}: ${day.tokens.toLocaleString(i18n.language)} tokens, ${day.requests} ${t('monitor.requests')}` : `${day.date}: ${t('monitor.historyUnavailable')}`}
          title={`${day.date} · ${day.available ? day.tokens.toLocaleString(i18n.language) + ' tokens' : t('monitor.historyUnavailable')}`}
          onFocus={() => setSelectedDate(day.date)} onClick={() => setSelectedDate(day.date)} onKeyDown={event => move(event, index)} />)}
      </div>
      <div className="usage-calendar-legend"><span>{days[0] && usageDate(days[0].date, i18n.language)}</span><div><span>{t('monitor.less')}</span>{[0, 1, 2, 3, 4].map(level => <i key={level} className={`usage-cell level-${level}`} />)}<span>{t('monitor.more')}</span></div></div>
      {availableDays < days.length && <div className="usage-unavailable-legend"><i className="usage-cell is-unavailable" /><span>{t('monitor.historyUnavailable')}</span></div>}
      <div className="usage-day-detail" aria-live="polite"><span>{selected?.date}</span>{selected?.available ? <><strong>{selected.tokens.toLocaleString(i18n.language)} <small>tokens</small></strong><span>{t('monitor.requestCount', { count: selected.requests })}</span></> : <strong>{t('monitor.historyUnavailable')}</strong>}</div>
    </section>
  )
}
