/**
 * Provider Filter Component
 * Supports filtering by type, status and search
 */

import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Search,
  Filter,
  X,
  RefreshCw,
  Plus,
  ChevronDown,
} from 'lucide-react'
import type { ProviderStatus, ProviderType } from '@/types/electron'
import { cn } from '@/lib/utils'

export type FilterType = 'all' | ProviderType | 'enabled' | 'disabled'
export type StatusFilter = 'all' | ProviderStatus

interface ProviderFilterProps {
  searchQuery: string
  onSearchChange: (query: string) => void
  typeFilter: FilterType
  onTypeFilterChange: (filter: FilterType) => void
  statusFilter: StatusFilter
  onStatusFilterChange: (filter: StatusFilter) => void
  onRefresh: () => void
  onAddProvider: () => void
  /** Label of the add button, e.g. for the official API tab. */
  addLabel?: string
  isRefreshing?: boolean
  stats?: {
    total: number
    builtin: number
    custom: number
    enabled: number
    online: number
  }
}

const typeFilterOptions: { value: FilterType; labelKey: string }[] = [
  { value: 'all', labelKey: 'providers.allTypes' },
  { value: 'enabled', labelKey: 'providers.enabledOnly' },
  { value: 'disabled', labelKey: 'providers.disabledOnly' },
]

const statusFilterOptions: { value: StatusFilter; labelKey: string; dot: string }[] = [
  { value: 'all', labelKey: 'providers.allStatus', dot: 'bg-muted-foreground/50' },
  { value: 'online', labelKey: 'providers.online', dot: 'bg-success' },
  { value: 'offline', labelKey: 'providers.offline', dot: 'bg-danger' },
  { value: 'unknown', labelKey: 'providers.unknown', dot: 'bg-muted-foreground/40' },
]

export function ProviderFilter({
  searchQuery,
  onSearchChange,
  typeFilter,
  onTypeFilterChange,
  statusFilter,
  onStatusFilterChange,
  onRefresh,
  onAddProvider,
  addLabel,
  isRefreshing = false,
  stats,
}: ProviderFilterProps) {
  const { t } = useTranslation()

  const activeStatus = statusFilterOptions.find(s => s.value === statusFilter) ?? statusFilterOptions[0]
  const hasActiveFilters = typeFilter !== 'all' || statusFilter !== 'all' || searchQuery !== ''

  const handleClearFilters = () => {
    onSearchChange('')
    onTypeFilterChange('all')
    onStatusFilterChange('all')
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <div className="relative min-w-0 flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t('providers.searchProviders')}
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="pl-9 pr-9"
            aria-label={t('common.search')}
          />
          {searchQuery && (
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
              onClick={() => onSearchChange('')}
              aria-label={t('common.reset')}
              title={t('common.reset')}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Select value={typeFilter} onValueChange={(v) => onTypeFilterChange(v as FilterType)}>
            <SelectTrigger className="w-[11rem]" aria-label={t('providers.providerType')}>
              <Filter className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-left"><SelectValue /></span>
            </SelectTrigger>
            <SelectContent>
              {typeFilterOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {t(option.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                className={cn('min-w-[9.5rem] justify-between gap-2', statusFilter !== 'all' && 'border-primary/60')}
                aria-label={`${t('providers.status')}: ${t(activeStatus.labelKey)}`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className={cn('h-2 w-2 shrink-0 rounded-full', activeStatus.dot)} />
                  <span className="truncate">{t(activeStatus.labelKey)}</span>
                </span>
                <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {statusFilterOptions.map((option) => (
                <DropdownMenuCheckboxItem
                  key={option.value}
                  checked={statusFilter === option.value}
                  onCheckedChange={() => onStatusFilterChange(option.value)}
                >
                  <div className="flex items-center gap-2">
                    <div className={cn('h-2 w-2 rounded-full', option.dot)} />
                    <span>{t(option.labelKey)}</span>
                  </div>
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <Button
            variant="outline"
            size="icon"
            onClick={onRefresh}
            disabled={isRefreshing}
            aria-label={t('providers.checkAllStatus')}
            title={t('providers.checkAllStatus')}
          >
            <RefreshCw className={cn('h-4 w-4', isRefreshing && 'animate-spin')} />
          </Button>

          <Button onClick={onAddProvider}>
            <Plus className="mr-2 h-4 w-4" />
            {addLabel || t('providers.addProvider')}
          </Button>
        </div>
      </div>

      {hasActiveFilters && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">{t('common.filter')}:</span>

          {searchQuery && (
            <Badge variant="secondary" className="gap-1">
              {t('common.search')}: {searchQuery}
              <button
                type="button"
                className="rounded-sm opacity-70 hover:opacity-100"
                onClick={() => onSearchChange('')}
                aria-label={`${t('common.reset')} ${t('common.search')}`}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          )}

          {typeFilter !== 'all' && (
            <Badge variant="secondary" className="gap-1">
              {t('providers.providerType')}: {t(typeFilterOptions.find(o => o.value === typeFilter)?.labelKey || '')}
              <button
                type="button"
                className="rounded-sm opacity-70 hover:opacity-100"
                onClick={() => onTypeFilterChange('all')}
                aria-label={`${t('common.reset')} ${t('providers.providerType')}`}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          )}

          {statusFilter !== 'all' && (
            <Badge variant="secondary" className="gap-1">
              {t('providers.status')}: {t(activeStatus.labelKey)}
              <button
                type="button"
                className="rounded-sm opacity-70 hover:opacity-100"
                onClick={() => onStatusFilterChange('all')}
                aria-label={`${t('common.reset')} ${t('providers.status')}`}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          )}

          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={handleClearFilters}
          >
            {t('common.reset')}
          </Button>
        </div>
      )}

      {stats && (
        <div className="flex flex-wrap items-center gap-2 text-[0.8125rem] text-muted-foreground">
          <span className="rounded-full border bg-card px-2.5 py-0.5">
            {t('providers.total')} <span className="font-semibold tabular-nums text-foreground">{stats.total}</span>
          </span>
          <span className="flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-0.5">
            <span className="h-2 w-2 rounded-full bg-success" />
            <span className="font-semibold tabular-nums text-foreground">{stats.online}</span> {t('providers.onlineCount')}
          </span>
          <span className="rounded-full border bg-card px-2.5 py-0.5">
            <span className="font-semibold tabular-nums text-foreground">{stats.enabled}</span> {t('providers.enabled')}
          </span>
        </div>
      )}
    </div>
  )
}

export default ProviderFilter
