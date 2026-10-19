import { useEffect, useState, useMemo } from 'react'
import { Power, Copy, Check, Play, Square, RotateCw, ExternalLink, Moon, Sun, Zap, Wifi, WifiOff } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTheme } from '@/hooks/useTheme'
import { useProvidersStore } from '@/stores/providersStore'
import iconsPng from '@/assets/icons/icons.png'
import { useTranslation } from 'react-i18next'
import { toast } from '@/hooks/use-toast'
import type { ProxyStatus } from '@shared/types'
import { useShallow } from 'zustand/react/shallow'
import { listenerAddress, listenerUrl } from '@/components/proxy/listener-utils'

interface ProviderInfo {
  id: string
  name: string
  accountCount: number
  activeCount: number
}

export function TrayView() {
  const { t } = useTranslation()
  const { toggleTheme, isDark } = useTheme()
  const { providers, accounts, setProviders, setAccounts, setIsLoading, isLoading } = useProvidersStore(useShallow(state => ({
    providers: state.providers, accounts: state.accounts, setProviders: state.setProviders, setAccounts: state.setAccounts, setIsLoading: state.setIsLoading, isLoading: state.isLoading,
  })))

  const [proxyRunning, setProxyRunning] = useState(false)
  const [proxyLoading, setProxyLoading] = useState(false)
  const [port, setPort] = useState(11434)
  const [host, setHost] = useState('127.0.0.1')
  const [copied, setCopied] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    const accept = (status: ProxyStatus) => {
      if (disposed) return
      setProxyRunning(status.isRunning)
      setPort(status.port)
      setHost(status.host || '127.0.0.1')
    }
    const loadProxyStatus = () => { void window.electronAPI.proxy.getStatus().then(accept).catch(error => console.error('[Tray] Proxy status:', error)) }
    loadProxyStatus()
    const unsubscribeProxy = window.electronAPI?.proxy?.onStatusChanged?.(accept)
    const unsubscribeConfig = window.electronAPI?.config?.onConfigChanged?.(loadProxyStatus)

    return () => {
      disposed = true
      unsubscribeProxy?.()
      unsubscribeConfig?.()
    }
  }, [])

  useEffect(() => {
    loadData()
  }, [])

  useEffect(() => {
    if (!selectedProvider && providers.length > 0) {
      const firstWithAccounts = providers.find((p) => {
        const count = accounts.filter((a) => a.providerId === p.id).length
        return count > 0
      })
      setSelectedProvider(firstWithAccounts?.id || providers[0]?.id || null)
    }
  }, [providers, accounts, selectedProvider])

  useEffect(() => {
    window.electronAPI?.send?.('tray:set-height', 460)
  }, [])

  const loadData = async () => {
    setIsLoading(true)
    try {
      const [providersData, accountsData] = await Promise.all([
        window.electronAPI?.providers?.getAll?.() || [],
        window.electronAPI?.accounts?.getAll?.() || [],
      ])
      setProviders(providersData)
      setAccounts(accountsData)
    } catch (error) {
      console.error('Failed to load data:', error)
    } finally {
      setIsLoading(false)
    }
  }

  const handleRefresh = async () => {
    setIsRefreshing(true)
    await loadData()
    setTimeout(() => setIsRefreshing(false), 1000)
  }

  const reportError = (error: unknown) => {
    toast({
      title: t('common.error'),
      description: error instanceof Error ? error.message : String(error),
      variant: 'destructive',
    })
  }

  const handleCopyUrl = async () => {
    const url = listenerUrl({ host, port })
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (error) {
      reportError(error)
    }
  }

  const toggleProxy = async () => {
    if (proxyLoading) return
    setProxyLoading(true)
    try {
      if (proxyRunning) {
        if (!await window.electronAPI?.proxy?.stop?.()) throw new Error(t('common.error'))
        setProxyRunning(false)
      } else {
        if (!await window.electronAPI?.proxy?.start?.()) throw new Error(t('common.error'))
        setProxyRunning(true)
      }
    } catch (error) {
      console.error('Failed to toggle proxy:', error)
      reportError(error)
    } finally {
      setProxyLoading(false)
    }
  }

  const openDashboard = () => {
    window.electronAPI?.send?.('tray:open-dashboard')
  }

  const quitApp = () => {
    window.electronAPI?.tray?.quitApp?.()
  }

  const providerList: ProviderInfo[] = useMemo(() => {
    return providers.map((p) => {
      const providerAccounts = accounts.filter((a) => a.providerId === p.id)
      return {
        id: p.id,
        name: p.name,
        accountCount: providerAccounts.length,
        activeCount: providerAccounts.filter((a) => a.status === 'active').length,
      }
    })
  }, [providers, accounts])

  const selectedProviderAccounts = useMemo(() => {
    if (!selectedProvider) return []
    return accounts.filter((a) => a.providerId === selectedProvider)
  }, [accounts, selectedProvider])


  return (
    <div className="relative flex h-[460px] w-full select-none flex-col overflow-hidden bg-background text-foreground">
      <div className="absolute top-0 left-0 right-0 h-6 drag-region z-50" />

      {/* Header */}
      <div className="relative flex-none overflow-hidden border-b">
        <div
          className="pointer-events-none absolute inset-0"
          style={{ background: 'radial-gradient(22rem 9rem at 0% 0%, rgba(var(--accent-primary-rgb), 0.16), transparent 70%)' }}
        />
        <div className="relative flex items-center justify-between px-4 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl border bg-card shadow-xs">
              <img src={iconsPng} alt="DailyWorkMate" className="h-8 w-8" />
            </div>
            <div>
              <h1 className="text-base font-bold tracking-tight">DailyWorkMate</h1>
              <div className={cn('mt-0.5 flex items-center gap-1.5 text-xs font-medium', proxyRunning ? 'text-success' : 'text-muted-foreground')}>
                {proxyRunning ? <Wifi size={12} /> : <WifiOff size={12} />}
                <span>
                  {proxyRunning
                    ? t('tray.serviceRunning')
                    : t('tray.serviceStopped')}
                </span>
              </div>
            </div>
          </div>
          <div className="no-drag relative z-[60] flex items-center gap-0.5">
            <button
              onClick={handleRefresh}
              disabled={isLoading || isRefreshing}
              aria-label={t('dashboard.refresh')}
              title={t('dashboard.refresh')}
              className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40"
            >
              <RotateCw size={15} className={cn((isLoading || isRefreshing) && 'animate-spin')} />
            </button>
            <button
              onClick={toggleTheme}
              aria-label={isDark ? t('settings.themeLight') : t('settings.themeDark')}
              title={isDark ? t('settings.themeLight') : t('settings.themeDark')}
              className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              {isDark ? <Sun size={15} /> : <Moon size={15} />}
            </button>
          </div>
        </div>
      </div>

      {/* Endpoint Card */}
      <section className="no-drag flex-none px-4 pt-3">
        <div className="rounded-xl border bg-card p-4 shadow-card">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex items-center gap-1.5">
                <Zap size={12} className="text-primary" />
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">API Endpoint</span>
              </div>
              <button
                onClick={handleCopyUrl}
                className="group flex items-center gap-1.5"
                aria-label={`${t('common.copy')} ${listenerUrl({ host, port })}`}
                title={t('common.copy')}
              >
                <code className="truncate font-mono text-sm font-semibold">
                  {listenerAddress({ host, port })}
                </code>
                {copied ? (
                  <Check size={12} className="flex-shrink-0 text-success" />
                ) : (
                  <Copy size={12} className="flex-shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                )}
              </button>
            </div>
            <button
              onClick={toggleProxy}
              disabled={proxyLoading}
              className={cn(
                'flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold shadow-xs transition-colors disabled:opacity-60',
                proxyRunning
                  ? 'border border-danger/30 bg-danger/10 text-danger hover:bg-danger/15'
                  : 'bg-primary text-primary-foreground hover:bg-primary/90'
              )}
            >
              {proxyRunning ? <Square size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
              <span>{proxyRunning ? t('tray.stop') : t('tray.start')}</span>
            </button>
          </div>
        </div>
      </section>

      {/* Provider Tabs */}
      {providerList.length > 0 && (
        <nav className="no-drag flex-none px-4 pb-2 pt-3">
          <div className="scrollbar-hide flex items-center gap-2 overflow-x-auto pb-1">
            {providerList.map((p) => (
              <button
                key={p.id}
                onClick={() => setSelectedProvider(p.id)}
                aria-pressed={selectedProvider === p.id}
                className={cn(
                  'flex-shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                  selectedProvider === p.id
                    ? 'border-primary/40 bg-primary/10 text-primary'
                    : 'border-border bg-card text-muted-foreground hover:bg-secondary hover:text-foreground'
                )}
              >
                {p.name}
                <span className="ml-1 tabular-nums opacity-70">
                  {p.activeCount}/{p.accountCount}
                </span>
              </button>
            ))}
          </div>
        </nav>
      )}

      {/* Account List */}
      <main className="no-drag min-h-0 flex-1 overflow-y-auto px-4">
        {isLoading && selectedProviderAccounts.length === 0 ? (
          <div className="flex items-center justify-center py-10">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-border border-t-primary" />
          </div>
        ) : selectedProviderAccounts.length === 0 ? (
          <div className="py-10 text-center">
            <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-secondary">
              <WifiOff size={20} className="text-muted-foreground" />
            </div>
            <p className="text-xs text-muted-foreground">{t('tray.noAccounts')}</p>
          </div>
        ) : (
          <div className="space-y-2 pb-3">
            {selectedProviderAccounts.map((account) => {
              const isActive = account.status === 'active'
              return (
                <div
                  key={account.id}
                  className="flex items-center justify-between rounded-lg border bg-card px-3 py-2.5"
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <div className={cn('h-2 w-2 flex-shrink-0 rounded-full', isActive ? 'bg-success' : 'bg-muted-foreground/40')} />
                    <span className="truncate text-sm font-medium">
                      {account.name || account.email || 'Unknown'}
                    </span>
                  </div>
                  <span className={cn(
                    'flex-shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold',
                    isActive
                      ? 'border-success/30 bg-success/10 text-success'
                      : 'border-border bg-secondary text-muted-foreground'
                  )}>
                    {isActive ? t('tray.active') : t('tray.inactive')}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="no-drag flex-none border-t p-4">
        <div className="flex gap-2">
          <button
            onClick={openDashboard}
            className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-primary py-2.5 text-sm font-semibold text-primary-foreground shadow-xs transition-colors hover:bg-primary/90"
          >
            <ExternalLink size={15} />
            <span>{t('tray.openDashboard')}</span>
          </button>
          <button
            onClick={quitApp}
            className="flex items-center justify-center gap-1.5 rounded-lg border bg-card px-4 py-2.5 text-sm font-semibold text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <Power size={15} />
            <span>{t('tray.quit')}</span>
          </button>
        </div>
      </footer>
    </div>
  )
}

export default TrayView
