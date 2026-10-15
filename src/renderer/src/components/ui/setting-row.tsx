import * as React from 'react'
import { cn } from '@/lib/utils'

interface SettingRowProps {
  /** Visible label; pass `htmlFor` so it targets the control. */
  label: React.ReactNode
  htmlFor?: string
  description?: React.ReactNode
  /** The control: a Switch, Select, Input or buttons. */
  children: React.ReactNode
  /** Stack the control under the text instead of beside it (wide inputs). */
  stacked?: boolean
  className?: string
}

/** One labelled preference. Rows inside a `SettingList` are separated by hairlines. */
export function SettingRow({ label, htmlFor, description, children, stacked = false, className }: SettingRowProps) {
  return (
    <div
      className={cn(
        'setting-row',
        stacked ? 'flex flex-col gap-3' : 'flex flex-wrap items-center justify-between gap-x-6 gap-y-3',
        className
      )}
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <label htmlFor={htmlFor} className="block text-sm font-medium leading-snug text-foreground">
          {label}
        </label>
        {description && <p className="text-[0.8125rem] leading-relaxed text-muted-foreground">{description}</p>}
      </div>
      <div className={cn('flex shrink-0 items-center gap-2', stacked && 'w-full')}>{children}</div>
    </div>
  )
}

/** Groups SettingRows with consistent dividers. */
export function SettingList({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('setting-list', className)} {...props} />
}
