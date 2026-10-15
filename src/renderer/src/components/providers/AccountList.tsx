/**
 * Account List Component
 * Displays all accounts under a provider with status and actions
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/hooks/use-toast'
import { 
  DropdownMenu, 
  DropdownMenuContent, 
  DropdownMenuItem, 
  DropdownMenuSeparator, 
  DropdownMenuTrigger 
} from '@/components/ui/dropdown-menu'
import { 
  MoreVertical, 
  Edit, 
  Trash2, 
  Check, 
  X, 
  Clock,
  User,
  RefreshCw,
  AlertCircle,
  Activity,
  Plus,
  Trash
} from 'lucide-react'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import type { Account, AccountStatus } from '@/types/electron'
import { cn } from '@/lib/utils'

interface AccountListProps {
  accounts: Account[]
  providerId: string
  onAddAccount: () => void
  onEditAccount: (account: Account) => void
  onDeleteAccount: (id: string) => void
  onValidateAccount: (id: string) => void
  onViewDetail: (account: Account) => void
}

export function AccountList({
  accounts,
  providerId,
  onAddAccount,
  onEditAccount,
  onDeleteAccount,
  onValidateAccount,
  onViewDetail,
}: AccountListProps) {
  const { t, i18n } = useTranslation()
  const { toast } = useToast()
  const [validatingIds, setValidatingIds] = useState<Set<string>>(new Set())
  const [clearingChatsId, setClearingChatsId] = useState<string | null>(null)
  const [showClearChatsDialog, setShowClearChatsDialog] = useState(false)
  const [selectedAccountForClear, setSelectedAccountForClear] = useState<Account | null>(null)

  const statusConfig: Record<AccountStatus, {
    labelKey: string
    badge: string
    avatar: string
    icon: typeof Check
  }> = {
    active: {
      labelKey: 'providers.active',
      badge: 'border-success/30 bg-success/10 text-success',
      avatar: 'bg-success/10 text-success',
      icon: Check,
    },
    inactive: {
      labelKey: 'providers.inactive',
      badge: 'border-border bg-muted text-muted-foreground',
      avatar: 'bg-muted text-muted-foreground',
      icon: Clock,
    },
    expired: {
      labelKey: 'providers.expired',
      badge: 'border-warning/30 bg-warning/10 text-warning',
      avatar: 'bg-warning/10 text-warning',
      icon: AlertCircle,
    },
    error: {
      labelKey: 'common.error',
      badge: 'border-danger/30 bg-danger/10 text-danger',
      avatar: 'bg-danger/10 text-danger',
      icon: X,
    },
  }

  const handleValidate = async (id: string) => {
    setValidatingIds(prev => new Set(prev).add(id))
    try {
      await onValidateAccount(id)
    } finally {
      setValidatingIds(prev => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  const handleClearChats = (account: Account) => {
    setSelectedAccountForClear(account)
    setShowClearChatsDialog(true)
  }

  const confirmClearChats = async () => {
    if (!selectedAccountForClear) return

    setClearingChatsId(selectedAccountForClear.id)
    try {
      const result = await window.electronAPI.accounts.clearChats(selectedAccountForClear.id)
      if (result.success) {
        toast({ title: t('providers.clearChatsSuccess') })
      } else {
        toast({
          title: t('providers.clearChatsFailed'),
          description: result.error,
          variant: 'destructive',
        })
      }
    } catch (error) {
      console.error('Failed to clear chats:', error)
      toast({
        title: t('providers.clearChatsFailed'),
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setClearingChatsId(null)
      setShowClearChatsDialog(false)
      setSelectedAccountForClear(null)
    }
  }

  const activeCount = accounts.filter(a => a.status === 'active').length
  const totalCount = accounts.length

  const formatDate = (timestamp?: number) => {
    if (!timestamp) return '-'
    return new Date(timestamp).toLocaleString(i18n.language, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  const formatUsage = (account: Account) => {
    if (account.dailyLimit) {
      return `${account.todayUsed || 0} / ${account.dailyLimit}`
    }
    return account.todayUsed || 0
  }

  if (accounts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed py-12 text-center">
        <User className="mb-3 h-10 w-10 text-muted-foreground/60" />
        <p className="mb-4 text-sm font-medium text-muted-foreground">{t('common.noData')}</p>
        <Button onClick={onAddAccount}>
          <Plus className="mr-2 h-4 w-4" />
          {t('providers.addAccount')}
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-[0.8125rem] text-muted-foreground">
          <span className="rounded-full border bg-card px-2.5 py-0.5">
            {t('providers.total')} <span className="font-semibold tabular-nums text-foreground">{totalCount}</span>
          </span>
          <span className="flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-0.5">
            <span className="h-2 w-2 rounded-full bg-success" />
            <span className="font-semibold tabular-nums text-foreground">{activeCount}</span> {t('providers.onlineCount')}
          </span>
        </div>
        <Button size="sm" onClick={onAddAccount}>
          <Plus className="mr-2 h-4 w-4" />
          {t('providers.addAccount')}
        </Button>
      </div>

      <div className="space-y-3">
        {accounts.map((account) => {
          const config = statusConfig[account.status]
          const StatusIcon = config.icon
          const isValidating = validatingIds.has(account.id)

          return (
            <Card
              key={account.id}
              hover
              role="button"
              tabIndex={0}
              className="cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              onClick={() => onViewDetail(account)}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onViewDetail(account)
                }
              }}
            >
              <CardContent className="p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <div className={cn(
                      'flex h-10 w-10 shrink-0 items-center justify-center rounded-full',
                      config.avatar
                    )}>
                      <User className="h-5 w-5" />
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate font-medium">{account.name}</span>
                        <Badge
                          variant="outline"
                          className={cn('text-xs', config.badge)}
                        >
                          <StatusIcon className="h-3 w-3" />
                          {t(config.labelKey)}
                        </Badge>
                      </div>

                      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
                        {account.email && (
                          <span className="truncate">{account.email}</span>
                        )}
                        <span className="tabular-nums">{t('dashboard.totalRequests')}: {account.requestCount || 0}</span>
                        <span className="tabular-nums">{t('providers.usedToday')}: {formatUsage(account)}</span>
                      </div>

                      {account.status === 'error' && account.errorMessage && (
                        <p className="mt-1 truncate text-xs text-danger">
                          {account.errorMessage}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    <div className="hidden text-right text-xs text-muted-foreground sm:block">
                      <div>{t('providers.lastCheck')}</div>
                      <div className="tabular-nums">{formatDate(account.lastUsed)}</div>
                    </div>

                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => e.stopPropagation()}
                          aria-label={t('common.actions')}
                          title={t('common.actions')}
                        >
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation()
                            onViewDetail(account)
                          }}
                        >
                          <Activity className="mr-2 h-4 w-4" />
                          {t('common.details')}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation()
                            handleValidate(account.id)
                          }}
                          disabled={isValidating}
                        >
                          <RefreshCw className={cn(
                            'mr-2 h-4 w-4',
                            isValidating && 'animate-spin'
                          )} />
                          {isValidating ? t('oauth.validating') : t('providers.validateCredentials')}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation()
                            onEditAccount(account)
                          }}
                        >
                          <Edit className="mr-2 h-4 w-4" />
                          {t('providers.editAccount')}
                        </DropdownMenuItem>
                        {/* Show Clear Chats for supported web providers */}
                        {(providerId === 'kimi' || providerId === 'qwen' || providerId === 'qwen-ai' || providerId === 'minimax' || providerId === 'zai' || providerId === 'perplexity' || providerId === 'deepseek' || providerId === 'glm' || providerId === 'mimo') && (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation()
                                handleClearChats(account)
                              }}
                              disabled={clearingChatsId === account.id}
                              className="text-warning focus:text-warning"
                            >
                              <Trash className="mr-2 h-4 w-4" />
                              {clearingChatsId === account.id ? t('common.loading') : t('providers.clearChats')}
                            </DropdownMenuItem>
                          </>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation()
                            onDeleteAccount(account.id)
                          }}
                          className="text-destructive focus:text-destructive"
                        >
                          <Trash2 className="mr-2 h-4 w-4" />
                          {t('providers.deleteAccount')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>

      <ConfirmDialog
        open={showClearChatsDialog}
        onOpenChange={open => {
          setShowClearChatsDialog(open)
          if (!open) setSelectedAccountForClear(null)
        }}
        destructive
        busy={clearingChatsId !== null}
        title={t('providers.clearChats')}
        description={t('providers.clearChatsConfirm')}
        onConfirm={confirmClearChats}
      >
        <p className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm font-medium text-warning">{t('providers.clearChatsWarning')}</p>
      </ConfirmDialog>
    </div>
  )
}

export default AccountList
