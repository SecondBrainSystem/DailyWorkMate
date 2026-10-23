import { useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { ChartNoAxesCombined, ChevronDown } from 'lucide-react'
import { compactUsage, type ModelUsage } from '@/lib/usageMetrics'

export interface TokenUsageCardProps {
  totalTokens: number
  models: ModelUsage[]
  selectedModel: string | null
  onSelectModel: (model: string | null) => void
}
const COLORS = ['var(--usage-accent)', 'var(--accent-primary)', '#e5a34b', '#e67bb5', '#65a7ef']
export function TokenUsageCard({ totalTokens, models, selectedModel, onSelectModel }: TokenUsageCardProps) {
  const { t, i18n } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const visible = expanded ? models : models.slice(0, 5)
  const attributed = models.reduce((sum, model) => sum + model.tokens, 0)
  const denominator = Math.max(totalTokens, attributed, 1)
  const segments = models.slice(0, 5).map((model, index) => ({ tokens: model.tokens, color: COLORS[index], model: model.model }))
  const remainder = Math.max(0, denominator - segments.reduce((sum, item) => sum + item.tokens, 0))
  const arcs = [...segments, { tokens: totalTokens || attributed ? remainder : 0, color: 'var(--text-dim)', model: '' }]
  return (
    <section className="usage-panel usage-models" aria-label={t('monitor.modelMix')}>
      <div className="usage-panel-heading"><h2><ChartNoAxesCombined aria-hidden="true" />{t('monitor.modelMix')}</h2>
        {selectedModel && <button className="usage-text-button" onClick={() => onSelectModel(null)}>{t('monitor.resetFilter')}</button>}
      </div>
      <div className="usage-donut">
        <svg viewBox="0 0 160 160" role="img" aria-label={t('monitor.modelMix')}>
          <circle cx="80" cy="80" r="62" fill="none" stroke="var(--bg-tertiary)" strokeWidth="12" />
          {arcs.map((arc, index) => {
            const start = arcs.slice(0, index).reduce((sum, item) => sum + item.tokens, 0) / denominator * 100
            const length = arc.tokens / denominator * 100
            return length > 0 && <circle key={index} cx="80" cy="80" r="62" fill="none" stroke={arc.color} strokeWidth="12" pathLength="100"
              strokeDasharray={`${Math.max(0, length - (length < 100 ? 0.8 : 0))} 100`} strokeDashoffset={-start} transform="rotate(-90 80 80)" />
          })}
        </svg>
        <div><strong>{models.length}</strong><span>{t('monitor.models')}</span></div>
      </div>
      <p className="usage-caption">{t('monitor.filterHint')}</p>
      {models.length === 0 ? <p className="usage-empty">{t('monitor.noModels')}</p> : <ul className="usage-model-list">
        {visible.map((item, index) => <li key={item.model}><button aria-pressed={selectedModel === item.model} onClick={() => onSelectModel(selectedModel === item.model ? null : item.model)}
          style={{ '--model-color': COLORS[index] || 'var(--text-dim)' } as CSSProperties} title={item.model}>
          <span className="usage-model-name"><i /><code>{item.model}</code></span>
          <span className="usage-model-value" title={item.tokens.toLocaleString(i18n.language)}>{compactUsage(item.tokens, i18n.language)}<small>{(item.tokens / denominator * 100).toFixed(1)}%</small></span>
          <span className="usage-model-bar"><i style={{ width: `${item.tokens / denominator * 100}%` }} /></span>
        </button></li>)}
      </ul>}
      {models.length > 5 && <button className="usage-text-button usage-expand" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
        {t(expanded ? 'dashboard.collapseTokenDetails' : 'dashboard.expandTokenDetails')}<ChevronDown size={14} />
      </button>}
      {totalTokens > attributed && <p className="usage-caption">{t('monitor.unattributed', { count: totalTokens - attributed })}</p>}
    </section>
  )
}
