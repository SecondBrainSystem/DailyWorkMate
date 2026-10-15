import { useTranslation } from 'react-i18next'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
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
  Copy, 
  RefreshCw, 
  Users,
  Plus,
  LogIn,
  Info,
  Download,
  Settings,
  Server,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Provider, ProviderStatus } from '@/types/electron'

import { providerIcons } from '@/lib/providerIcons'
import { ApiProviderIcon } from './AddApiProviderDialog'

interface ProviderCardProps {
  provider: Provider
  status?: ProviderStatus
  accountCount: number
  activeAccountCount: number
  onToggle: (id: string, enabled: boolean) => void
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  onDuplicate: (id: string) => void
  onCheckStatus: (id: string) => void
  onManageAccounts: (id: string) => void
  onUpdateModels?: (id: string) => void
  onManageModels?: (id: string) => void
  className?: string
}

const statusStyles: Record<ProviderStatus, { pill: string; dot: string }> = {
  online: { pill: 'border-success/30 bg-success/10 text-success', dot: 'bg-success' },
  offline: { pill: 'border-danger/30 bg-danger/10 text-danger', dot: 'bg-danger' },
  unknown: { pill: 'border-border bg-muted text-muted-foreground', dot: 'bg-muted-foreground/50' },
}

export function ProviderCard({
  provider,
  status,
  accountCount,
  activeAccountCount,
  onToggle,
  onEdit,
  onDelete,
  onDuplicate,
  onCheckStatus,
  onManageAccounts,
  onUpdateModels,
  onManageModels,
  className,
}: ProviderCardProps) {
  const { t } = useTranslation()
  const isBuiltin = provider.type === 'builtin'
  // Official API-key providers: vendor icon, "API" badge, and model refresh from the vendor's list.
  const isApi = provider.upstreamKind === 'api'
  const icon = providerIcons[provider.id]
  const currentStatus = status || provider.status || 'unknown'

  const statusTexts: Record<ProviderStatus, string> = {
    online: t('providers.online'),
    offline: t('providers.offline'),
    unknown: t('providers.unknown'),
  }

  const getProviderName = () => {
    if (isBuiltin && provider.id) {
      return t(`${provider.id}.name`, { defaultValue: provider.name })
    }
    return provider.name
  }

  const getProviderDescription = () => {
    if (isBuiltin && provider.id) {
      return t(`${provider.id}.description`, { defaultValue: provider.description })
    }
    return provider.description
  }

  const providerName = getProviderName()

  return (
    <Card className={cn(!provider.enabled && 'opacity-80', className)}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 p-5 pb-4">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl border bg-card shadow-xs">
            {isApi ? (
              <ApiProviderIcon preset={provider.apiPreset} name={provider.name} />
            ) : icon ? (
              <img
                src={icon}
                alt=""
                className="h-7 w-7 object-contain"
              />
            ) : (
              <Server className="h-5 w-5 text-muted-foreground" />
            )}
          </div>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-base font-semibold leading-snug tracking-tight">{providerName}</h3>
              <Badge variant="outline" className="text-[0.6875rem]">
                {isApi ? 'API' : isBuiltin ? t('providers.builtin') : t('providers.custom')}
              </Badge>
            </div>
            <p className="text-[0.8125rem] leading-relaxed text-muted-foreground">
              {getProviderDescription() || `${provider.supportedModels?.length || 0} ${t('providers.models').toLowerCase()}`}
            </p>
            {provider.id === 'perplexity' && (
              <p className="flex items-center gap-1 text-xs text-warning">
                <Info className="h-3 w-3 flex-shrink-0" />
                <span>{t('perplexity.freeUserNotice')}</span>
              </p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium', statusStyles[currentStatus].pill)}>
            <span className={cn('h-1.5 w-1.5 rounded-full', statusStyles[currentStatus].dot)} />
            {statusTexts[currentStatus]}
          </span>
          <Switch
            checked={provider.enabled}
            onCheckedChange={(checked) => onToggle(provider.id, checked)}
            aria-label={`${providerName}: ${provider.enabled ? t('providers.enabled') : t('providers.disabled')}`}
            title={provider.enabled ? t('providers.enabled') : t('providers.disabled')}
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={t('common.actions')} title={t('common.actions')}>
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => onManageAccounts(provider.id)}>
                <Users className="mr-2 h-4 w-4" />
                {t('providers.accountManagement')} ({activeAccountCount}/{accountCount})
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onCheckStatus(provider.id)}>
                <RefreshCw className="mr-2 h-4 w-4" />
                {t('providers.checkStatus')}
              </DropdownMenuItem>
              {isApi && onUpdateModels && (
                <DropdownMenuItem onClick={() => onUpdateModels(provider.id)}>
                  <Download className="mr-2 h-4 w-4" />
                  {t('providers.api.refreshModels')}
                </DropdownMenuItem>
              )}
              {(isBuiltin || isApi) && (
                <DropdownMenuItem onClick={() => onManageModels?.(provider.id)}>
                  <Settings className="mr-2 h-4 w-4" />
                  {t('providers.manageModels')}
                </DropdownMenuItem>
              )}
              {isBuiltin && provider.id === 'qwen-ai' && onUpdateModels && (
                <DropdownMenuItem onClick={() => onUpdateModels?.(provider.id)}>
                  <Download className="mr-2 h-4 w-4" />
                  {t('providers.updateModels')}
                </DropdownMenuItem>
              )}
              {!isBuiltin && !isApi && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => onEdit(provider.id)}>
                    <Edit className="mr-2 h-4 w-4" />
                    {t('providers.editProvider')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onDuplicate(provider.id)}>
                    <Copy className="mr-2 h-4 w-4" />
                    {t('providers.duplicateProvider')}
                  </DropdownMenuItem>
                </>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => onDelete(provider.id)}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="mr-2 h-4 w-4" />
                {t('providers.deleteProvider')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <CardContent className="pt-0">
        <div className="flex flex-wrap items-center justify-between gap-4 border-t pt-4">
          <dl className="grid min-w-0 flex-1 grid-cols-3 gap-4 text-sm">
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">{t('providers.accounts')}</dt>
              <dd className="mt-0.5 font-medium tabular-nums">
                {activeAccountCount} / {accountCount} <span className="font-normal text-muted-foreground">{t('providers.online').toLowerCase()}</span>
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">{t('providers.models')}</dt>
              <dd className="mt-0.5 font-medium tabular-nums">
                {provider.supportedModels?.length || 0}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">{t('providers.authType')}</dt>
              <dd className="mt-0.5 truncate font-medium">
                {isApi ? 'API Key' : getAuthTypeLabel(provider.authType, t)}
              </dd>
            </div>
          </dl>

          <Button
            size="sm"
            variant={accountCount === 0 ? 'default' : 'outline'}
            onClick={() => onManageAccounts(provider.id)}
            className="shrink-0"
          >
            {accountCount === 0 ? (
              <>
                <Plus className="h-4 w-4 mr-1.5" />
                {t('providers.addAccount')}
              </>
            ) : (
              <>
                <LogIn className="h-4 w-4 mr-1.5" />
                {t('providers.accountManagement')}
              </>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function getAuthTypeLabel(authType: string, t: (key: string, fallback: string) => string): string {
  // Unknown auth types (e.g. from custom providers) fall back to their raw id.
  return t(`providers.authTypes.${authType}`, authType)
}

export default ProviderCard
