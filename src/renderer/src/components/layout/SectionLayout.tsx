import { Suspense } from 'react'
import { NavLink, Navigate, Outlet, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { sectionNavigation } from './navigation'
import { useGuardedNavigate } from './navigationGuard'
import { useNavigationStore } from '@/stores/navigationStore'

/** Related tools share one sidebar entry; URLs still identify each tool. */
export function SectionLayout({ section }: { section: keyof typeof sectionNavigation }) {
  const { t } = useTranslation()
  const navigate = useGuardedNavigate()
  const hasBlockers = useNavigationStore(state => state.blockers.length > 0)
  return (
    <div className="section-layout">
      <nav className="section-navigation" aria-label={t(section === 'api' ? 'nav.apiService' : `nav.${section}`)}>
        {sectionNavigation[section].map(({ href, titleKey, icon: Icon }) => (
          <NavLink key={href} to={href} onClick={event => {
            if (hasBlockers) { event.preventDefault(); navigate(href) }
          }} className={({ isActive }) => `section-navigation-link${isActive ? ' is-active' : ''}`}>
            <Icon aria-hidden="true" /><span>{t(titleKey)}</span>
          </NavLink>
        ))}
      </nav>
      <Suspense fallback={<div role="status" className="p-8 text-sm text-muted-foreground">{t('common.loading')}</div>}><Outlet /></Suspense>
    </div>
  )
}

/** Preserve old bookmarks, tray links and query filters. */
export function LegacyRedirect({ to, logs = false }: { to: string; logs?: boolean }) {
  const { search } = useLocation()
  const params = new URLSearchParams(search)
  const target = logs ? (params.get('tab') === 'app' ? '/monitor/events' : '/monitor/requests') : to
  if (logs) params.delete('tab')
  const [pathname, defaults] = target.split('?')
  new URLSearchParams(defaults).forEach((value, key) => params.set(key, value))
  return <Navigate to={{ pathname, search: params.toString() }} replace />
}
