import { lazy, Suspense, useEffect, useState } from 'react'
import ErrorBoundary from '@/components/ErrorBoundary'
import { useProxyStore } from '@/stores/proxyStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { Outlet, useLocation } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { Header } from './Header'
import { NavigationGuardDialog } from './navigationGuard'
import { TYPOGRAPHY_FONTS } from '../../../../shared/typography'
const Companion = lazy(() => import('@/pages/Companion').then(m => ({ default: m.Companion })))

export function MainLayout() {
  const { pathname } = useLocation()
  const [companionLoaded, setCompanionLoaded] = useState(pathname === '/')
  useEffect(() => { if (pathname === '/') setCompanionLoaded(true) }, [pathname])
  const typography = useSettingsStore(state => state.uiTypography)
  const sidebarHidden = useSettingsStore(state => state.sidebarHidden)
  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--app-font-size', typography.fontSize + 'px')
    root.style.setProperty('--app-font-family', TYPOGRAPHY_FONTS[typography.fontFamily])
    root.style.setProperty('--app-font-weight', String(typography.fontWeight))
  }, [typography.fontSize, typography.fontFamily, typography.fontWeight])
  useEffect(() => {
    const { fetchConfig, setConfig } = useSettingsStore.getState()
    const unsubscribe = window.electronAPI?.config?.onConfigChanged?.(config => { setConfig(config); useProxyStore.setState({ appConfig: config, modelMappings: Object.values(config.modelMappings), loadBalanceStrategy: config.loadBalanceStrategy }) })
    void fetchConfig()
    return () => unsubscribe?.()
  }, [])

  return (
    <div className="app-shell">
      {!sidebarHidden && <Sidebar />}
      <div className="app-main">
        <Header />
        <main className="app-content">
          {companionLoaded && <div className="app-page" hidden={pathname !== '/'}><ErrorBoundary><Suspense fallback={null}><Companion visible={pathname === '/'} /></Suspense></ErrorBoundary></div>}
          {/* "/" renders nothing here (the Assistant above stays mounted); an empty padded page would add a page scroll. */}
          <div className="app-page" key={pathname} hidden={pathname === '/'}>
            <ErrorBoundary><Outlet /></ErrorBoundary>
          </div>
        </main>
      </div>
      <NavigationGuardDialog />
    </div>
  )
}
