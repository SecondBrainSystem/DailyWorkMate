import { useTranslation } from 'react-i18next'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ErrorText } from './error-text'
import { cn } from '@/lib/utils'

interface LoadErrorProps {
  /** The underlying error text, shown under the generic heading. */
  message: string
  onRetry?: () => void
  retrying?: boolean
  className?: string
}

/** Inline notice for data that failed to load, so an empty list is never mistaken for "nothing here". */
export function LoadError({ message, onRetry, retrying = false, className }: LoadErrorProps) {
  const { t } = useTranslation()
  return (
    <div role="alert" className={cn('flex flex-wrap items-start gap-3 rounded-xl border border-danger/30 bg-danger/5 p-3 text-sm', className)}>
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-danger">{t('common.loadFailed')}</p>
        <p className="mt-0.5 break-words text-muted-foreground"><ErrorText error={message} /></p>
      </div>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
          <RefreshCw className={cn('mr-2 h-3.5 w-3.5', retrying && 'animate-spin')} />
          {t('common.retry')}
        </Button>
      )}
    </div>
  )
}
