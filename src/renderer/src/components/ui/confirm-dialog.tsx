import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: React.ReactNode
  description?: React.ReactNode
  /** Defaults to "Confirm". */
  confirmLabel?: React.ReactNode
  /** Defaults to "Cancel". */
  cancelLabel?: React.ReactNode
  /** Red confirm button and warning icon, for irreversible actions. */
  destructive?: boolean
  /** Shows a spinner and blocks both buttons while the action runs. */
  busy?: boolean
  onConfirm: () => void | Promise<void>
  /** Extra content between the description and the buttons. */
  children?: React.ReactNode
}

/**
 * The one confirmation pattern for the app: replaces window.confirm (which
 * ignores the theme) and the hand-built "Are you sure?" dialogs.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  destructive = false,
  busy = false,
  onConfirm,
  children,
}: ConfirmDialogProps) {
  const { t } = useTranslation()

  return (
    <Dialog open={open} onOpenChange={next => { if (!busy) onOpenChange(next) }}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5">
            {destructive && (
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-danger/10 text-danger">
                <AlertTriangle className="h-4 w-4" />
              </span>
            )}
            {title}
          </DialogTitle>
          {description && <DialogDescription className="leading-relaxed">{description}</DialogDescription>}
        </DialogHeader>
        {children}
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {cancelLabel ?? t('common.cancel')}
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            onClick={() => { void onConfirm() }}
            disabled={busy}
            className={cn(busy && 'gap-2')}
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {confirmLabel ?? t('common.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
