import { useTranslation } from 'react-i18next'
import { CheckCircle2, Loader2, RotateCw, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { PreverifyState } from '@/lib/modelPreverify'

interface ModelCheckBadgeProps {
  state: PreverifyState
  onRecheck?: () => void
  className?: string
}

/** Compact status for the background model check, shown next to a model picker. */
export function ModelCheckBadge({ state, onRecheck, className }: ModelCheckBadgeProps) {
  const { t } = useTranslation()
  if (state.status === 'idle') return null

  const base = 'inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium'
  // Healthy states are an icon with a tooltip; only failures spell out their message.
  const quiet = (label: string, icon: React.ReactNode, tone: string) => (
    <span role="status" title={label} className={cn('inline-grid h-6 w-6 shrink-0 place-items-center rounded-full', tone, className)}>
      {icon}<span className="sr-only">{label}</span>
    </span>
  )
  if (state.status === 'checking') return quiet(t('modelCheck.checking'), <Loader2 className="h-3.5 w-3.5 animate-spin" />, 'text-muted-foreground')
  if (state.status === 'skipped') return quiet(t('modelCheck.skipped'), <CheckCircle2 className="h-3.5 w-3.5" />, 'text-muted-foreground')
  if (state.status === 'ready') return quiet(t('modelCheck.ready'), <CheckCircle2 className="h-3.5 w-3.5" />, 'text-success')
  return (
    <span role="status" title={state.error} tabIndex={0} className={cn(base, 'border-danger/30 bg-danger/10 text-danger', className)}>
      <XCircle className="h-3.5 w-3.5 shrink-0" />
      <span className="break-words">{state.error || t('modelCheck.failed')}</span>
      {onRecheck && (
        <button
          type="button"
          onClick={onRecheck}
          className="ml-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full hover:bg-danger/15"
          aria-label={t('modelCheck.retry')}
          title={t('modelCheck.retry')}
        >
          <RotateCw className="h-3 w-3" />
        </button>
      )}
    </span>
  )
}
