import { useTranslation } from 'react-i18next'
import { Sun, Moon, Monitor, Languages, Play, Pause, Loader2, PanelLeft, Sparkles, Bot } from 'lucide-react'
import { useLocation } from 'react-router-dom'
import { useGuardedNavigate } from './navigationGuard'
import { useTheme } from '@/hooks/useTheme'
import { cn } from '@/lib/utils'
import { useEffect, useState } from 'react'
import { useSettingsStore, type Theme } from '@/stores/settingsStore'
import { toast } from '@/hooks/use-toast'
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
  const { language, setLanguage, sidebarHidden, toggleSidebarHidden } = useSettingsStore()
  const { pathname } = useLocation()
  const guardedNavigate = useGuardedNavigate()
  const [proxyEnabled, setProxyEnabled] = useState(false)
  const [proxyLoading, setProxyLoading] = useState(false)
  const [port, setPort] = useState(11434)
  const [host, setHost] = useState('127.0.0.1')

  useEffect(() => {
    if (!window.electronAPI?.proxy?.onStatusChanged) return

    const unsubscribe = window.electronAPI.proxy.onStatusChanged((status) => {
      setProxyEnabled(status.isRunning)
      if (status.port) setPort(status.port)
      setHost(status.host || '127.0.0.1')
    })

    window.electronAPI.proxy.getStatus().then((status) => {
      setProxyEnabled(status.isRunning)
      if (status.port) setPort(status.port)
      setHost(status.host || '127.0.0.1')
    })

    window.electronAPI.config?.get?.().then((config) => {
      if (!config) return
      setPort(config.proxyPort || 11434)
      setHost(config.proxyHost || '127.0.0.1')
    })

    const unsubscribeConfig = window.electronAPI.config?.onConfigChanged?.((config) => {
      setPort(config.proxyPort || 11434)
      setHost(config.proxyHost || '127.0.0.1')
    })

    return () => {
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
        setProxyEnabled(false)
      } else {
        if (!await window.electronAPI.proxy.start()) throw new Error(t('header.proxyStartFailed'))
        setProxyEnabled(true)
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
    setLanguage(language === 'zh-CN' ? 'en-US' : 'zh-CN')
  }

  const proxyAction = proxyEnabled ? t('proxyStatus.stop') : t('proxyStatus.start')

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
        <span className="proxy-pill-label">
          {host}:{port}
        </span>
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
          title={language === 'zh-CN' ? t('header.switchToEnglish') : t('header.switchToChinese')}
          aria-label={language === 'zh-CN' ? t('header.switchToEnglish') : t('header.switchToChinese')}
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
