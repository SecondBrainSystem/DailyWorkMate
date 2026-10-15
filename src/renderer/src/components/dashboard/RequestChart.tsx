import { useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardHeading } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { Activity } from 'lucide-react'

export interface ChartDataPoint {
  time: string
  requests: number
  success: number
  failed: number
}

export interface RequestChartProps {
  data: ChartDataPoint[]
  className?: string
}

const CHART_WIDTH = 640
const CHART_HEIGHT = 240
const CHART_PADDING = {
  top: 12,
  right: 8,
  bottom: 30,
  left: 8,
}

/**
 * Requests per day with failures on the same scale. Successful requests are
 * total minus failed, so they are shown in the tooltip rather than as a third
 * line that would sit on top of the total.
 */
export function RequestChart({ data, className }: RequestChartProps) {
  const { t } = useTranslation()
  const gradientId = useId()
  const svgRef = useRef<SVGSVGElement>(null)
  const [active, setActive] = useState<number | null>(null)

  const series = useMemo(() => [
    { key: 'requests' as const, label: t('dashboard.totalRequests'), color: 'var(--chart-primary)' },
    { key: 'failed' as const, label: t('common.error'), color: 'var(--chart-critical)' },
  ], [t])

  const chart = useMemo(() => {
    const plotWidth = CHART_WIDTH - CHART_PADDING.left - CHART_PADDING.right
    const plotHeight = CHART_HEIGHT - CHART_PADDING.top - CHART_PADDING.bottom
    const rawMax = Math.max(1, ...data.flatMap(point => [point.requests, point.failed]))
    const magnitude = Math.pow(10, Math.floor(Math.log10(rawMax)))
    const maxValue = Math.ceil(rawMax / magnitude) * magnitude
    const yTicks = [...new Set([maxValue, Math.floor(maxValue / 2), 0])]
    const xStep = data.length > 1 ? plotWidth / (data.length - 1) : 0
    const labelEvery = Math.max(1, Math.ceil(data.length / 7))
    // Every Nth date, and always the latest one; drop the label just before it if they would collide.
    const labelled = new Set(data.map((_, index) => index).filter(index => index % labelEvery === 0))
    const last = data.length - 1
    if (last >= 0 && !labelled.has(last)) {
      const previous = Math.max(...labelled)
      if (last - previous < labelEvery) labelled.delete(previous)
      labelled.add(last)
    }

    const x = (index: number) => CHART_PADDING.left + (data.length > 1 ? index * xStep : plotWidth / 2)
    const y = (value: number) => CHART_PADDING.top + (1 - value / maxValue) * plotHeight
    const pathFor = (key: 'requests' | 'failed') =>
      data
        .map((point, index) => `${index === 0 ? 'M' : 'L'} ${x(index).toFixed(2)} ${y(point[key]).toFixed(2)}`)
        .join(' ')
    const baseline = y(0)
    const areaPath = data.length > 0
      ? `${pathFor('requests')} L ${x(data.length - 1).toFixed(2)} ${baseline} L ${x(0).toFixed(2)} ${baseline} Z`
      : ''

    return { maxValue, yTicks, labelled, x, y, pathFor, areaPath, xStep }
  }, [data])

  const indexFromPointer = (event: PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current
    if (!svg || data.length === 0) return null
    const rect = svg.getBoundingClientRect()
    const viewX = ((event.clientX - rect.left) / rect.width) * CHART_WIDTH
    if (data.length === 1) return 0
    const index = Math.round((viewX - CHART_PADDING.left) / chart.xStep)
    return Math.min(data.length - 1, Math.max(0, index))
  }

  const handleKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    if (data.length === 0) return
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      setActive(current => Math.min(data.length - 1, (current ?? -1) + 1))
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      setActive(current => Math.max(0, (current ?? data.length) - 1))
    } else if (event.key === 'Escape') {
      setActive(null)
    }
  }

  const point = active !== null ? data[active] : null
  const tooltipLeft = active !== null ? (chart.x(active) / CHART_WIDTH) * 100 : 0

  return (
    <Card className={cn('', className)}>
      <CardHeading
        icon={Activity}
        title={t('dashboard.requestsTrend')}
        actions={
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {series.map(item => (
              <span key={item.key} className="flex items-center gap-1.5">
                <span className="h-0.5 w-3 rounded-full" style={{ backgroundColor: item.color }} />
                {item.label}
              </span>
            ))}
          </div>
        }
      />
      <CardContent>
        {/* Fixed-width gutter keeps y labels legible however wide the plot stretches. */}
        <div className="relative h-[260px] w-full pl-10">
          {data.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {t('common.noData')}
            </div>
          ) : (
            <div className="relative h-full w-full">
              <svg
                ref={svgRef}
                viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
                preserveAspectRatio="none"
                className="h-full w-full overflow-visible rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                role="img"
                tabIndex={0}
                aria-label={t('dashboard.requestsTrend')}
                onPointerMove={event => setActive(indexFromPointer(event))}
                onPointerLeave={() => setActive(null)}
                onFocus={() => setActive(current => current ?? data.length - 1)}
                onBlur={() => setActive(null)}
                onKeyDown={handleKeyDown}
              >
                <defs>
                  <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--chart-primary)" stopOpacity="0.18" />
                    <stop offset="100%" stopColor="var(--chart-primary)" stopOpacity="0" />
                  </linearGradient>
                </defs>

                {chart.yTicks.map(tick => (
                  <line
                    key={tick}
                    x1={CHART_PADDING.left}
                    x2={CHART_WIDTH - CHART_PADDING.right}
                    y1={chart.y(tick)}
                    y2={chart.y(tick)}
                    stroke="hsl(var(--border))"
                    strokeDasharray={tick === 0 ? undefined : '3 4'}
                    vectorEffect="non-scaling-stroke"
                  />
                ))}

                <path d={chart.areaPath} fill={`url(#${gradientId})`} />

                {series.map(item => (
                  <path
                    key={item.key}
                    d={chart.pathFor(item.key)}
                    fill="none"
                    stroke={item.color}
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                  />
                ))}

                {active !== null && (
                  <line
                    x1={chart.x(active)}
                    x2={chart.x(active)}
                    y1={CHART_PADDING.top}
                    y2={CHART_HEIGHT - CHART_PADDING.bottom}
                    stroke="var(--text-dim)"
                    strokeWidth={1}
                    vectorEffect="non-scaling-stroke"
                  />
                )}
              </svg>

              {/* Axis labels live in HTML so they keep their size when the SVG stretches. */}
              {chart.yTicks.map(tick => (
                <span
                  key={tick}
                  className="pointer-events-none absolute -left-10 w-8 -translate-y-1/2 text-right text-[11px] tabular-nums text-muted-foreground"
                  style={{ top: `${(chart.y(tick) / CHART_HEIGHT) * 100}%` }}
                >
                  {tick.toLocaleString()}
                </span>
              ))}
              {data.map((entry, index) => (
                chart.labelled.has(index) ? (
                  <span
                    key={`${entry.time}-${index}`}
                    className="pointer-events-none absolute bottom-0 -translate-x-1/2 whitespace-nowrap text-[11px] tabular-nums text-muted-foreground"
                    style={{ left: `${(chart.x(index) / CHART_WIDTH) * 100}%` }}
                  >
                    {entry.time}
                  </span>
                ) : null
              ))}

              {active !== null && series.map(item => (
                <span
                  key={item.key}
                  className="pointer-events-none absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[var(--glass-bg)]"
                  style={{
                    left: `${tooltipLeft}%`,
                    top: `${(chart.y(data[active][item.key]) / CHART_HEIGHT) * 100}%`,
                    backgroundColor: item.color,
                  }}
                />
              ))}

              {point && (
                <div
                  role="status"
                  className={cn(
                    'pointer-events-none absolute top-1 z-10 min-w-[9.5rem] rounded-lg border bg-popover px-3 py-2 text-xs shadow-float',
                    tooltipLeft > 60 ? '-translate-x-[calc(100%+12px)]' : 'translate-x-3'
                  )}
                  style={{ left: `${tooltipLeft}%` }}
                >
                  <div className="mb-1.5 font-medium text-muted-foreground">{point.time}</div>
                  {series.map(item => (
                    <div key={item.key} className="flex items-center justify-between gap-4 py-0.5">
                      <span className="flex items-center gap-1.5 text-muted-foreground">
                        <span className="h-0.5 w-3 rounded-full" style={{ backgroundColor: item.color }} />
                        {item.label}
                      </span>
                      <span className="font-semibold tabular-nums text-foreground">{point[item.key].toLocaleString()}</span>
                    </div>
                  ))}
                  <div className="mt-1 flex items-center justify-between gap-4 border-t pt-1">
                    <span className="text-muted-foreground">{t('dashboard.successRate')}</span>
                    <span className="font-semibold tabular-nums text-foreground">
                      {point.requests > 0 ? Math.round(((point.requests - point.failed) / point.requests) * 100) : 0}%
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {data.length > 0 && (
          <table className="sr-only">
            <caption>{t('dashboard.requestsTrend')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('common.date')}</th>
                {series.map(item => <th key={item.key} scope="col">{item.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {data.map(entry => (
                <tr key={entry.time}>
                  <th scope="row">{entry.time}</th>
                  {series.map(item => <td key={item.key}>{entry[item.key]}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  )
}
