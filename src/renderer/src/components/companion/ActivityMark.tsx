import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2 } from 'lucide-react'
import type { ActivityState } from '@/lib/terminalActivity'

/**
 * Working (pulsing dot) or finished and not yet looked at (check); otherwise the caller's own status mark.
 * `announce={false}` leaves the words out of the control's name; the caller describes the state instead.
 */
export function ActivityMark({ state, idle = null, announce = true }: { state: ActivityState; idle?: ReactNode; announce?: boolean }) {
  const { t } = useTranslation()
  if (state === 'working') return <><i className="terminal-activity" aria-hidden="true" />{announce && <span className="sr-only">{t('terminal.activity.working')}</span>}</>
  if (state === 'done') return <><CheckCircle2 size={13} strokeWidth={2.4} className="terminal-done" aria-hidden="true" />{announce && <span className="sr-only">{t('terminal.activity.done')}</span>}</>
  return <>{idle}</>
}
