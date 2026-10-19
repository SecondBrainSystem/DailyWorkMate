import { useShallow } from 'zustand/react/shallow'
import { useTranslation } from 'react-i18next'
import { Sun, Moon, Monitor, Languages, Play, Pause, Loader2, PanelLeft, Sparkles, Bot } from 'lucide-react'
import { useLocation } from 'react-router-dom'
import { useGuardedNavigate } from './navigationGuard'
import { useTheme } from '@/hooks/useTheme'
import { useIsChinese } from '@/hooks/useIsChinese'
import { listenerAddress } from '@/components/proxy/listener-utils'
import { cn } from '@/lib/utils'
import { useEffect, useState } from 'react'
import { useSettingsStore, type Theme } from '@/stores/settingsStore'
import { toast } from '@/hooks/use-toast'
import type { ProxyStatus } from '@shared/types'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

const themeOptions = [
  { value: 'light', labelKey: 'settings.themeLight', icon: Sun },
  { value: 'dark', labelKey: 'settings.themeDark', icon: Moon },
  { value: 'system', labelKey: 'settings.themeSystem', icon: Monitor },
] as const

// The two conversation pages get a direct switch so they stay one click apart with the sidebar hidden.
const workspaceTabs = [
  { href: '/', labelKey: 'nav.companion', icon: Sparkles },
  { href: '/chat', labelKey: 'nav.chat', icon: Bot },
] as const

/**
 * The only proxy switch, theme picker and language switch in the app;
 * pages link here instead of repeating these controls.
 */
export function Header() {
  const { t } = useTranslation()
  const { theme, setTheme, isDark } = useTheme()
  const { setLanguage, sidebarHidden, toggleSidebarHidden } = useSettingsStore(useShallow(state => ({ setLanguage: state.setLanguage, sidebarHidden: state.sidebarHidden, toggleSidebarHidden: state.toggleSidebarHidden })))
  const chinese = useIsChinese()
  const { pathname } = useLocation()
  const guardedNavigate = useGuardedNavigate()
  const [proxyEnabled, setProxyEnabled] = useState(false)
  const [proxyLoading, setProxyLoading] = useState(false)
  const [port, setPort] = useState(11434)
  const [host, setHost] = useState('127.0.0.1')
  const [serviceCount, setServiceCount] = useState(0)

  useEffect(() => {
    if (!window.electronAPI?.proxy?.onStatusChanged) return

    let disposed = false
    const accept = (status: ProxyStatus) => {
      if (disposed) return
      setProxyEnabled(status.isRunning)
      if (status.port) setPort(status.port)
      setHost(status.host || '127.0.0.1')
      setServiceCount(status.listeners?.filter(listener => listener.isRunning).length ?? (status.isRunning ? 1 : 0))
    }
    const refresh = () => { void window.electronAPI.proxy.getStatus().then(accept).catch(error => console.error('[Header] Proxy status:', error)) }
    const unsubscribe = window.electronAPI.proxy.onStatusChanged(accept)
    refresh()
    const unsubscribeConfig = window.electronAPI.config?.onConfigChanged?.(refresh)

    return () => {
      disposed = true
      unsubscribe()
      unsubscribeConfig?.()
    }
  }, [])

  const handleToggleProxy = async () => {
    if (proxyLoading) return
    setProxyLoading(true)
    try {
      if (proxyEnabled) {
        if (!await window.electronAPI.proxy.stop()) throw new Error(t('header.proxyStopFailed'))
      } else {
        if (!await window.electronAPI.proxy.start()) throw new Error(t('header.proxyStartFailed'))
      }
    } catch (error) {
      console.error('Failed to toggle proxy:', error)
      toast({
        title: t('common.error'),
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      })
    } finally {
      setProxyLoading(false)
    }
  }

  const toggleLanguage = () => {
    setLanguage(chinese ? 'en-US' : 'zh-CN')
  }

  const proxyAction = proxyEnabled ? serviceCount > 1 ? t('proxyStatus.stopAll') : t('proxyStatus.stop') : t('proxyStatus.start')

  return (
    <header className="app-topbar">
      <div className="flex min-w-0 items-center gap-2">
      <button
        onClick={toggleSidebarHidden}
        className="topbar-icon-btn"
        title={sidebarHidden ? t('nav.showSidebar') : t('nav.hideSidebar')}
        aria-label={sidebarHidden ? t('nav.showSidebar') : t('nav.hideSidebar')}
        aria-pressed={!sidebarHidden}
      >
        <PanelLeft />
      </button>

      <div className="workspace-switch" role="tablist" aria-label={t('nav.switchWorkspace')}>
        {workspaceTabs.map(({ href, labelKey, icon: Icon }) => (
          <button
            key={href}
            role="tab"
            aria-selected={pathname === href}
            className="workspace-switch-tab"
            onClick={() => guardedNavigate(href)}
          >
            <Icon aria-hidden="true" />
            <span>{t(labelKey)}</span>
          </button>
        ))}
      </div>

      <div className={cn('proxy-pill', proxyEnabled && 'proxy-toggle-active')}>
        <span className={cn('proxy-pill-dot', proxyLoading && 'animate-pulse')} />
        <span className="proxy-pill-state">
          {proxyEnabled ? t('dashboard.running') : t('dashboard.stopped')}
        </span>
        <button type="button" className="proxy-pill-label" title={t('proxyStatus.manage')} onClick={() => guardedNavigate('/proxy')}>
          {listenerAddress({ host, port })}
          {serviceCount > 1 && ` +${serviceCount - 1}`}
        </button>
        <button
          onClick={handleToggleProxy}
          disabled={proxyLoading}
          className={cn(
            'proxy-pill-btn disabled:cursor-not-allowed disabled:opacity-60',
            proxyEnabled && 'proxy-toggle-btn-active'
          )}
          title={proxyAction}
          aria-label={proxyAction}
        >
          {proxyLoading ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : proxyEnabled ? (
            <Pause className="h-3 w-3" />
          ) : (
            <Play className="h-3 w-3" />
          )}
        </button>
      </div>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <button
          onClick={toggleLanguage}
          className="topbar-icon-btn"
          title={chinese ? t('header.switchToEnglish') : t('header.switchToChinese')}
          aria-label={chinese ? t('header.switchToEnglish') : t('header.switchToChinese')}
        >
          <Languages />
        </button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="topbar-icon-btn" title={t('settings.theme')} aria-label={t('settings.theme')}>
              {isDark ? <Moon /> : <Sun />}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[10rem]">
            <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">{t('settings.theme')}</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={theme} onValueChange={(value) => setTheme(value as Theme)}>
              {themeOptions.map(({ value, labelKey, icon: Icon }) => (
                <DropdownMenuRadioItem key={value} value={value} className="gap-2">
                  <Icon className="h-4 w-4 text-muted-foreground" />
                  {t(labelKey)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
