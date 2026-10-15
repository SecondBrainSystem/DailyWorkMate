import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Coins } from 'lucide-react'

import { Card, CardContent, CardHeading } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

export interface TokenUsageCardProps {
  totalTokens: number
  modelTokenUsage: Record<string, number>
  className?: string
}

const TOP_COUNT = 5

/** Total tokens plus the per-model breakdown, shown as a ranked list with share bars. */
export function TokenUsageCard({ totalTokens, modelTokenUsage, className }: TokenUsageCardProps) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const models = Object.entries(modelTokenUsage)
    .filter(([, tokens]) => tokens > 0)
    .sort(([, left], [, right]) => right - left)
  const largest = models[0]?.[1] ?? 0
  const visible = expanded ? models : models.slice(0, TOP_COUNT)

  return (
    <Card className={className}>
      <CardHeading icon={Coins} title={t('dashboard.totalTokens')} description={t('dashboard.tokenModelCount', { count: models.length })} />
      <CardContent className="space-y-4">
        <div className="text-3xl font-bold tabular-nums tracking-tight">{totalTokens.toLocaleString()}</div>

        {models.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('dashboard.noTokenUsage')}</p>
        ) : (
          <ul className="space-y-3">
            {visible.map(([model, tokens]) => (
              <li key={model} className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <code className="min-w-0 truncate font-mono text-[0.8125rem]" title={model}>{model}</code>
                  <span className="shrink-0 tabular-nums text-muted-foreground">{tokens.toLocaleString()}</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-secondary" aria-hidden="true">
                  <div
                    className="h-full rounded-full bg-[var(--chart-primary)]"
                    style={{ width: `${Math.max(2, (tokens / largest) * 100)}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}

        {models.length > TOP_COUNT && (
          <Button variant="ghost" size="sm" className="-ml-2" onClick={() => setExpanded(current => !current)} aria-expanded={expanded}>
            {expanded ? t('dashboard.collapseTokenDetails') : t('dashboard.expandTokenDetails')}
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
