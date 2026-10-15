import type { ComponentType, ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface PageHeaderProps {
  title: ReactNode
  /** Context shown only as the title's tooltip, so headers stay a single uncluttered line. */
  description?: ReactNode
  icon?: ComponentType<{ className?: string }>
  actions?: ReactNode
  className?: string
}

/** Shared single-row title bar, kept short so the page content gets the space. */
export function PageHeader({ title, description, icon: Icon, actions, className }: PageHeaderProps) {
  return (
    <header className={cn('page-header', className)}>
      <div className="page-header-main">
        {Icon && (
          <div className="page-header-icon" aria-hidden="true">
            <Icon />
          </div>
        )}
        <div className="page-header-text">
          <h1 className="page-header-title" title={typeof description === 'string' ? description : undefined}>{title}</h1>
        </div>
      </div>
      {actions && <div className="page-header-actions">{actions}</div>}
    </header>
  )
}
