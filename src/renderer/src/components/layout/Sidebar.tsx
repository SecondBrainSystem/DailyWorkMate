import { useEffect, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/settingsStore'
import { useNavigationStore } from '@/stores/navigationStore'
import logoIcon from '@/assets/icons/icons.png'
import { navGroups, type NavItem } from './navigation'
import { useGuardedNavigate } from './navigationGuard'

function Tooltip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="tooltip-container">
      {children}
      <div className="tooltip-content" role="tooltip">
        {label}
      </div>
    </div>
  )
}

export function Sidebar() {
  const { t } = useTranslation()
  const { sidebarCollapsed, toggleSidebar } = useSettingsStore()
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 767px)').matches)
  useEffect(() => {
    const query = window.matchMedia('(max-width: 767px)')
    const update = () => setNarrow(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  const collapsed = sidebarCollapsed || narrow
  const hasBlockers = useNavigationStore(state => state.blockers.length > 0)
  const guardedNavigate = useGuardedNavigate()
  const location = useLocation()

  const renderNavButton = (item: NavItem) => {
    const title = t(item.titleKey)
    const link = (
      <NavLink
        to={item.href}
        end={item.href === '/'}
        aria-label={collapsed ? title : undefined}
        onClick={(e) => {
          // With unsaved changes the shared guard dialog decides whether to leave.
          if (hasBlockers && location.pathname !== item.href) {
            e.preventDefault()
            guardedNavigate(item.href)
          }
        }}
        className={({ isActive }) =>
          cn(
            'sidebar-nav-item',
            collapsed ? 'collapsed' : 'expanded',
            isActive ? 'active' : 'inactive'
          )
        }
      >
        <item.icon className="flex-shrink-0" />
        {!collapsed && <span className="truncate">{title}</span>}
      </NavLink>
    )

    return collapsed ? <Tooltip label={title}>{link}</Tooltip> : link
  }

  return (
    <aside className={cn('app-sidebar', collapsed && 'is-collapsed')}>
      <div className="sidebar-brand">
        <div className="sidebar-brand-mark">
          <img src={logoIcon} alt="DailyWorkMate" className="h-6 w-6 object-contain" />
        </div>
        {!collapsed && (
          <div className="min-w-0">
            <div className="sidebar-brand-name">DailyWorkMate</div>
            <div className="sidebar-brand-tag">{t('nav.tagline')}</div>
          </div>
        )}
      </div>

      <nav className="sidebar-scroll">
        {navGroups.map((group) => (
          <div key={group.labelKey} className="sidebar-section">
            <div className="sidebar-section-label">{t(group.labelKey)}</div>
            {group.items.map((item) => (
              <div key={item.href}>{renderNavButton(item)}</div>
            ))}
          </div>
        ))}
      </nav>

      <div className="sidebar-footer">
        <button
          className="sidebar-collapse-btn"
          onClick={toggleSidebar}
          disabled={narrow}
          aria-label={collapsed ? t('nav.expand') : t('nav.collapse')}
          title={collapsed ? t('nav.expand') : t('nav.collapse')}
        >
          {collapsed ? (
            <PanelLeftOpen className="h-[1.125rem] w-[1.125rem]" />
          ) : (
            <>
              <PanelLeftClose className="h-[1.125rem] w-[1.125rem] flex-shrink-0" />
              <span className="truncate">{t('nav.collapse')}</span>
            </>
          )}
        </button>
      </div>
    </aside>
  )
}
