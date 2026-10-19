import { useShallow } from 'zustand/react/shallow'
import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardHeading } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useProxyStore } from '@/stores/proxyStore'
import { useToast } from '@/hooks/use-toast'
import type { LoadBalanceStrategy, Account, Provider } from '@/types/electron'
import { Scale, RefreshCw, Info } from 'lucide-react'

interface LoadBalanceConfigProps {
  onConfigChange?: () => void
}

/**
 * Only the strategy is configurable: the proxy has no per-account weights,
 * so the accounts are listed read-only to show what the strategy rotates over.
 */
export function LoadBalanceConfig({ onConfigChange }: LoadBalanceConfigProps) {
  const { t } = useTranslation()
  const { loadBalanceStrategy, setLoadBalanceStrategy, saveAppConfig, isLoading } = useProxyStore(useShallow(state => ({ loadBalanceStrategy: state.loadBalanceStrategy, setLoadBalanceStrategy: state.setLoadBalanceStrategy, saveAppConfig: state.saveAppConfig, isLoading: state.isLoading })))
  const { toast } = useToast()

  const initialStrategyRef = useRef<LoadBalanceStrategy>(loadBalanceStrategy)

  const [selectedStrategy, setSelectedStrategy] = useState<LoadBalanceStrategy>(loadBalanceStrategy)
  const [accounts, setAccounts] = useState<(Account & { provider?: Provider })[]>([])
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [hasChanges, setHasChanges] = useState(false)

  useEffect(() => {
    void fetchAccounts()
  }, [])

  useEffect(() => {
    setSelectedStrategy(loadBalanceStrategy)
    initialStrategyRef.current = loadBalanceStrategy
  }, [])

  const fetchAccounts = async () => {
    setIsRefreshing(true)
    try {
      const allAccounts = await window.electronAPI.accounts.getAll()
      const providers = await window.electronAPI.providers.getAll()

      setAccounts(allAccounts.map(account => ({
        ...account,
        provider: providers.find(p => p.id === account.providerId),
      })))
    } catch (error) {
      console.error(t('proxy.failedToGetAccounts'), error)
      toast({
        title: t('proxy.failedToGetAccounts'),
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      })
    } finally {
      setIsRefreshing(false)
    }
  }

  const handleStrategyChange = (value: LoadBalanceStrategy) => {
    setSelectedStrategy(value)
    setHasChanges(value !== initialStrategyRef.current)
    onConfigChange?.()
  }

  const handleSave = async () => {
    setLoadBalanceStrategy(selectedStrategy)

    const success = await saveAppConfig({
      loadBalanceStrategy: selectedStrategy,
    })

    if (success) {
      initialStrategyRef.current = selectedStrategy
      setHasChanges(false)
      toast({
        title: t('common.success'),
        description: t('proxy.loadBalanceConfig'),
      })
    } else {
      toast({
        title: t('common.error'),
        description: t('proxy.configSaveFailed'),
        variant: 'destructive',
      })
    }
  }

  const handleReset = () => {
    setSelectedStrategy(initialStrategyRef.current)
    setHasChanges(false)
  }

  const activeAccounts = accounts.filter(a => a.status === 'active')

  const getStrategyLabel = (strategy: LoadBalanceStrategy): string => {
    const labels: Record<LoadBalanceStrategy, string> = {
      'round-robin': t('proxy.roundRobin'),
      'fill-first': t('proxy.fillFirst'),
      'failover': t('proxy.failover'),
    }
    return labels[strategy]
  }

  const getStrategyDescription = (strategy: LoadBalanceStrategy): string => {
    const descriptions: Record<LoadBalanceStrategy, string> = {
      'round-robin': t('proxy.roundRobinDesc'),
      'fill-first': t('proxy.fillFirstDesc'),
      'failover': t('proxy.failoverDesc'),
    }
    return descriptions[strategy]
  }

  return (
    <Card>
      <CardHeading
        icon={Scale}
        title={t('proxy.loadBalanceConfig')}
        description={t('proxy.loadBalanceConfigDesc')}
        actions={hasChanges && (
          <Badge variant="secondary" className="text-xs">
            {t('proxy.unsaved')}
          </Badge>
        )}
      />
      <CardContent className="space-y-6">
        <div className="space-y-2">
          <Label htmlFor="strategy">{t('proxy.loadBalanceStrategy')}</Label>
          <Select value={selectedStrategy} onValueChange={handleStrategyChange}>
            <SelectTrigger id="strategy">
              <SelectValue placeholder={t('proxy.selectStrategy')} />
            </SelectTrigger>
            <SelectContent>
              {(['round-robin', 'fill-first', 'failover'] as LoadBalanceStrategy[]).map((strategy) => (
                <SelectItem key={strategy} value={strategy}>
                  {getStrategyLabel(strategy)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex items-start gap-2 rounded-xl border bg-muted/40 p-3">
            <Info className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
            <p className="text-sm text-muted-foreground">
              {getStrategyDescription(selectedStrategy)}
            </p>
          </div>
        </div>

        <div className="space-y-3 border-t pt-4">
          <div className="flex items-center justify-between gap-3">
            <Label>{t('proxy.activeAccountsInRotation', { count: activeAccounts.length })}</Label>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { void fetchAccounts() }}
              disabled={isRefreshing}
              className="h-8 px-2"
              title={t('common.refresh')}
            >
              <RefreshCw className={`h-3.5 w-3.5 mr-1 ${isRefreshing ? 'animate-spin' : ''}`} />
              {t('common.refresh')}
            </Button>
          </div>

          {activeAccounts.length > 0 ? (
            <ul className="flex flex-wrap gap-2">
              {activeAccounts.map(account => (
                <li key={account.id} className="flex items-center gap-1.5 rounded-full border bg-muted/40 px-3 py-1 text-sm">
                  <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />
                  <span className="font-medium">{account.name}</span>
                  {account.provider && <span className="text-muted-foreground">· {account.provider.name}</span>}
                </li>
              ))}
            </ul>
          ) : (
            <div className="rounded-xl border border-dashed py-6 text-center text-muted-foreground">
              <p className="text-sm font-medium">{t('proxy.noActiveAccounts')}</p>
              <p className="text-xs mt-1">{t('proxy.addAndActivateAccount')}</p>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t pt-4">
          <Button
            variant="outline"
            onClick={handleReset}
            disabled={!hasChanges || isLoading}
          >
            {t('common.reset')}
          </Button>
          <Button
            onClick={handleSave}
            disabled={!hasChanges || isLoading}
          >
            {isLoading ? t('proxy.saving') : t('proxy.saveConfig')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

export default LoadBalanceConfig
