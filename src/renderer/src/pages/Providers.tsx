/**
 * Provider Management Page
 * Integrates all components for CRUD operations on providers and accounts
 */

import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '@/hooks/use-toast'
import { useProviderRefresh } from '@/hooks/use-provider-refresh'
import { useProvidersStore } from '@/stores/providersStore'
import {
  ProviderCard,
  AddProviderDialog,
  CustomProviderForm,
  AccountList,
  AddAccountDialog,
  AccountDetail,
  ProviderFilter,
} from '@/components/providers'
import { ModelEditor } from '@/components/models/ModelEditor'
import type { 
  Provider, 
  ProviderStatus, 
  BuiltinProviderConfig,
  CustomProviderFormData,
  Account,
} from '@/types/electron'
import { FilterType, StatusFilter } from '@/components/providers/ProviderFilter'
import { Server, ArrowLeft } from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirmation-provider'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { AddApiProviderDialog } from '@/components/providers/AddApiProviderDialog'
import type { ApiProviderResult } from '@shared/apiProviders'

type ViewMode = 'providers' | 'accounts' | 'account-detail'
/** Web-account providers (built in) and official API-key providers are listed separately; Ollama nodes have their own page. */
type Section = 'web' | 'api'
const SECTION_KEY = 'dailyworkmate.providers.section'
const readSection = (): Section => { try { return localStorage.getItem(SECTION_KEY) === 'api' ? 'api' : 'web' } catch { return 'web' } }
const sectionOf = (provider: Provider): Section | null => provider.upstreamKind === 'ollama' ? null : provider.upstreamKind === 'api' || provider.type === 'custom' ? 'api' : 'web'

export function Providers() {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const { toast } = useToast()
  const store = useProvidersStore()
  useProviderRefresh(error => toast({ title: t('common.error'), description: String(error), variant: 'destructive' }))
  const hasLoadedRef = useRef(false)
  
  const [viewMode, setViewMode] = useState<ViewMode>('providers')
  const [searchQuery, setSearchQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<FilterType>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [section, setSection] = useState<Section>(readSection)
  const chooseSection = (next: Section) => { setSection(next); try { localStorage.setItem(SECTION_KEY, next) } catch { /* per-device convenience only */ } }
  const [apiDialog, setApiDialog] = useState<{ open: boolean; preset?: string }>({ open: false })
  
  const [showAddProviderDialog, setShowAddProviderDialog] = useState(false)
  const [showCustomProviderForm, setShowCustomProviderForm] = useState(false)
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null)
  
  const [showAddAccountDialog, setShowAddAccountDialog] = useState(false)
  const [editingAccount, setEditingAccount] = useState<Account | null>(null)
  
  const [showModelEditor, setShowModelEditor] = useState(false)
  const [modelEditorProvider, setModelEditorProvider] = useState<{ id: string; name: string } | null>(null)
  
  useEffect(() => {
    if (hasLoadedRef.current) return
    hasLoadedRef.current = true
    
    const loadInitialData = async () => {
      if (!window.electronAPI?.providers?.getAll) {
        console.log('electronAPI not available')
        useProvidersStore.getState().setIsLoading(false)
        useProvidersStore.getState().setProviders([])
        useProvidersStore.getState().setBuiltinProviders([])
        useProvidersStore.getState().setAccounts([])
        return
      }
      
      try {
        useProvidersStore.getState().setIsLoading(true)
        const [providersData, builtinData, accountsData] = await Promise.all([
          window.electronAPI.providers.getAll(),
          window.electronAPI.providers.getBuiltin(),
          window.electronAPI.accounts.getAll(),
        ])
        
        useProvidersStore.getState().setProviders(providersData)
        useProvidersStore.getState().setBuiltinProviders(builtinData)
        useProvidersStore.getState().setAccounts(accountsData)
        
        const existingStatuses = useProvidersStore.getState().providerStatuses
        const statusMap: Record<string, ProviderStatus> = { ...existingStatuses }
        const countMap: Record<string, { total: number; active: number }> = {}
        
        for (const provider of providersData) {
          if (provider.status) {
            statusMap[provider.id] = provider.status
          } else if (!statusMap[provider.id]) {
            statusMap[provider.id] = 'unknown'
          }
          const providerAccounts = accountsData.filter(a => a.providerId === provider.id)
          countMap[provider.id] = {
            total: providerAccounts.length,
            active: providerAccounts.filter(a => a.status === 'active').length,
          }
        }
        
        useProvidersStore.getState().setProviderStatuses(statusMap)
        useProvidersStore.getState().setAccountCounts(countMap)
      } catch (error) {
        console.error('Failed to load providers:', error)
        toast({
          title: t('common.error'),
          description: error instanceof Error ? error.message : t('providers.operationFailed'),
          variant: 'destructive',
        })
      } finally {
        useProvidersStore.getState().setIsLoading(false)
      }
    }
    
    loadInitialData()
  }, [])

  const sectionProviders = store.providers.filter(provider => sectionOf(provider) === section)
  const sectionCounts = { web: store.providers.filter(provider => sectionOf(provider) === 'web').length, api: store.providers.filter(provider => sectionOf(provider) === 'api').length }
  const filteredProviders = sectionProviders.filter((provider) => {
    const matchesSearch = 
      provider.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      provider.description?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      provider.supportedModels?.some(model => 
        model.toLowerCase().includes(searchQuery.toLowerCase())
      )

    if (!matchesSearch) return false

    switch (typeFilter) {
      case 'builtin':
        if (provider.type !== 'builtin') return false
        break
      case 'custom':
        if (provider.type !== 'custom') return false
        break
      case 'enabled':
        if (!provider.enabled) return false
        break
      case 'disabled':
        if (provider.enabled) return false
        break
    }

    if (statusFilter !== 'all') {
      if (store.providerStatuses[provider.id] !== statusFilter) return false
    }

    return true
  })

  const handleToggleProvider = async (id: string, enabled: boolean) => {
    try {
      await window.electronAPI.providers.update(id, { enabled })
      store.updateProvider(id, { enabled })
      toast({
        title: enabled ? t('providers.enabled') : t('providers.disabled'),
        description: enabled ? t('providers.providerEnabled') : t('providers.providerDisabled'),
      })
    } catch (error) {
      toast({
        title: t('providers.operationFailed'),
        description: t('providers.cannotUpdateProviderStatus'),
        variant: 'destructive',
      })
    }
  }

  const handleEditProvider = (id: string) => {
    const provider = store.providers.find(p => p.id === id)
    if (provider) {
      setEditingProvider(provider)
      setShowCustomProviderForm(true)
    }
  }

  const handleDeleteProvider = async (id: string) => {
    if (!await confirm(t('providers.deleteProvider') + '? ' + t('providers.accountManagement'))) return
    try {
      const success = await window.electronAPI.providers.delete(id)
      if (success) {
        store.removeProvider(id)
        toast({
          title: t('providers.deleteSuccess'),
          description: t('providers.providerDeleted'),
        })
      }
    } catch (error) {
      toast({
        title: t('providers.deleteFailed'),
        description: error instanceof Error ? error.message : t('providers.cannotDeleteProvider'),
        variant: 'destructive',
      })
    }
  }

  const handleDuplicateProvider = async (id: string) => {
    try {
      const newProvider = await window.electronAPI.providers.duplicate(id)
      store.addProvider(newProvider)
      toast({
        title: t('providers.duplicateSuccess'),
        description: t('providers.providerDuplicated'),
      })
    } catch (error) {
      toast({
        title: t('providers.duplicateFailed'),
        description: t('providers.cannotDuplicateProvider'),
        variant: 'destructive',
      })
    }
  }

  const handleCheckProviderStatus = async (id: string) => {
    try {
      const result = await window.electronAPI.providers.checkStatus(id)
      store.updateProviderStatus(id, result.status)
      toast({
        title: result.status === 'online' ? t('providers.providerOnline') : t('providers.providerOffline'),
        description: result.error || `${t('providers.latency')}: ${result.latency}ms`,
        variant: result.status === 'online' ? 'default' : 'destructive',
      })
    } catch (error) {
      toast({
        title: t('providers.checkFailed'),
        description: t('providers.cannotCheckProviderStatus'),
        variant: 'destructive',
      })
    }
  }

  const handleCheckAllStatus = async () => {
    setIsRefreshing(true)
    try {
      const statuses = await window.electronAPI.providers.checkAllStatus()
      const newStatusMap: Record<string, ProviderStatus> = {}
      for (const [id, result] of Object.entries(statuses)) {
        newStatusMap[id] = result.status
      }
      store.setProviderStatuses(newStatusMap)
      toast({
        title: t('providers.statusRefreshed'),
        description: `${t('providers.onlineCount')}: ${Object.values(newStatusMap).filter(s => s === 'online').length} / ${store.providers.length}`,
      })
    } catch (error) {
      toast({
        title: t('providers.refreshFailed'),
        description: t('providers.cannotRefreshProviderStatus'),
        variant: 'destructive',
      })
    } finally {
      setIsRefreshing(false)
    }
  }

  const handleUpdateModels = async (providerId: string) => {
    try {
      toast({
        title: t('providers.updatingModels'),
      })
      
      const result = await window.electronAPI.providers.updateModels?.(providerId)
      
      if (result?.success) {
        const providers = await window.electronAPI.providers.getAll()
        useProvidersStore.getState().setProviders(providers)
        toast({
          title: t('providers.modelsUpdated'),
          description: t('providers.modelsUpdatedDesc'),
        })
      } else {
        toast({
          title: t('providers.updateModelsFailed'),
          description: result?.error || t('common.error'),
          variant: 'destructive',
        })
      }
    } catch (error) {
      toast({
        title: t('providers.updateModelsFailed'),
        description: error instanceof Error ? error.message : t('common.error'),
        variant: 'destructive',
      })
    }
  }

  /** After an official API key is added: reload providers and keys, and say what was added. */
  const handleApiAdded = async (result: ApiProviderResult, name: string) => {
    const [providers, accounts] = await Promise.all([window.electronAPI.providers.getAll(), window.electronAPI.accounts.getAll()])
    const state = useProvidersStore.getState()
    state.setProviders(providers); state.setAccounts(accounts)
    state.setAccountCounts(Object.fromEntries(providers.map(provider => {
      const keys = accounts.filter(account => account.providerId === provider.id)
      return [provider.id, { total: keys.length, active: keys.filter(account => account.status === 'active').length }]
    })))
    state.setProviderStatuses({ ...state.providerStatuses, [result.providerId]: 'online' })
    toast({
      title: result.addedKey ? t('providers.api.keyAdded', { name }) : t('providers.api.added', { name }),
      description: t('providers.api.modelCount', { count: result.models.length }) + (result.sharedModels.length ? ' ' + t('providers.api.shared', { models: result.sharedModels.slice(0, 6).join(', ') + (result.sharedModels.length > 6 ? '…' : '') }) : ''),
    })
  }

  const handleManageModels = (providerId: string) => {
    const provider = store.providers.find(p => p.id === providerId)
    if (provider) {
      setModelEditorProvider({ id: provider.id, name: provider.name })
      setShowModelEditor(true)
    }
  }

  const handleManageAccounts = (providerId: string) => {
    store.setSelectedProviderId(providerId)
    setViewMode('accounts')
  }

  const handleSelectBuiltinProvider = async (provider: BuiltinProviderConfig, credentials: Record<string, string>) => {
    let targetProvider = store.providers.find(p => p.id === provider.id)
    
    if (!targetProvider) {
      const newProvider = await window.electronAPI.providers.add({
        id: provider.id,
        name: provider.name,
        type: 'builtin',
        authType: provider.authType,
        apiEndpoint: provider.apiEndpoint,
        headers: provider.headers,
        description: provider.description,
        supportedModels: provider.supportedModels,
        credentialFields: provider.credentialFields,
      })
      store.addProvider(newProvider)
      targetProvider = newProvider
    }
    
    if (credentials && Object.keys(credentials).length > 0) {
      const account = await window.electronAPI.accounts.add({
        providerId: targetProvider.id,
        name: `${provider.name} ${t('providers.accounts')}`,
        credentials: credentials,
      })
      store.addAccount(account)
      
      const providerAccounts = store.getAccountsByProvider(targetProvider.id)
      store.updateAccountCount(targetProvider.id, providerAccounts.length, providerAccounts.filter(a => a.status === 'active').length)
    }
    
    setShowAddProviderDialog(false)
    toast({
      title: t('providers.addSuccess'),
      description: `${provider.name} ${t('providers.accounts')} ${t('providers.accountAdded')}`,
    })
  }

  const handleCreateCustomProvider = () => {
    setShowAddProviderDialog(false)
    setShowCustomProviderForm(true)
  }

  const handleCustomProviderFormSubmit = async (data: CustomProviderFormData) => {
    try {
      if (editingProvider) {
        const updated = await window.electronAPI.providers.update(editingProvider.id, {
          name: data.name,
          authType: data.authType,
          apiEndpoint: data.apiEndpoint,
          headers: data.headers,
          description: data.description,
          supportedModels: data.supportedModels,
          credentialFields: data.credentialFields,
        })
        if (updated) {
          store.updateProvider(editingProvider.id, updated)
          toast({
            title: t('providers.updateSuccess'),
            description: t('providers.providerConfigUpdated'),
          })
        }
      } else {
        const newProvider = await window.electronAPI.providers.add({
          name: data.name,
          authType: data.authType,
          apiEndpoint: data.apiEndpoint,
          headers: data.headers,
          description: data.description,
          supportedModels: data.supportedModels,
          credentialFields: data.credentialFields,
        })
        store.addProvider(newProvider)
        toast({
          title: t('providers.createSuccess'),
          description: t('providers.customProviderCreated'),
        })
      }
      setShowCustomProviderForm(false)
      setEditingProvider(null)
    } catch (error) {
      toast({
        title: editingProvider ? t('providers.updateFailed') : t('providers.createFailed'),
        description: error instanceof Error ? error.message : t('providers.operationFailed'),
        variant: 'destructive',
      })
      throw error
    }
  }

  const handleAddAccount = async (data: {
    name: string
    email?: string
    credentials: Record<string, string>
    dailyLimit?: number
  }) => {
    if (!store.selectedProviderId) return
    
    try {
      const account = await window.electronAPI.accounts.add({
        providerId: store.selectedProviderId,
        name: data.name,
        email: data.email,
        credentials: data.credentials,
        dailyLimit: data.dailyLimit,
      })
      store.addAccount(account)
      
      const providerAccounts = store.getAccountsByProvider(store.selectedProviderId)
      store.updateAccountCount(
        store.selectedProviderId,
        providerAccounts.length,
        providerAccounts.filter(a => a.status === 'active').length
      )
      
      setShowAddAccountDialog(false)
      toast({
        title: t('providers.addSuccess'),
        description: t('providers.accountAdded'),
      })
    } catch (error) {
      toast({
        title: t('providers.addFailed'),
        description: error instanceof Error ? error.message : t('providers.cannotAddAccount'),
        variant: 'destructive',
      })
      throw error
    }
  }

  const handleUpdateAccount = async (id: string, updates: Partial<Account>) => {
    try {
      const account = store.getAccountById(id)
      if (!account) throw new Error(t('providers.operationFailed'))
      
      const updated = await window.electronAPI.accounts.update(id, updates)
      if (updated) {
        store.updateAccount(id, updated)
        
        if (store.selectedProviderId) {
          const providerAccounts = store.getAccountsByProvider(store.selectedProviderId)
          store.updateAccountCount(
            store.selectedProviderId,
            providerAccounts.length,
            providerAccounts.filter(a => a.status === 'active').length
          )
        }
        
        toast({
          title: t('providers.updateSuccess'),
          description: t('providers.accountUpdated'),
        })
      }
    } catch (error) {
      toast({
        title: t('providers.updateFailed'),
        description: error instanceof Error ? error.message : t('providers.operationFailed'),
        variant: 'destructive',
      })
      throw error
    }
  }

  const handleDeleteAccount = async (id: string) => {
    if (!await confirm(t('providers.deleteAccount') + '?')) return
    try {
      const success = await window.electronAPI.accounts.delete(id)
      if (success) {
        const account = store.getAccountById(id)
        store.removeAccount(id)
        
        if (account && store.selectedProviderId) {
          const providerAccounts = store.getAccountsByProvider(store.selectedProviderId)
          store.updateAccountCount(
            store.selectedProviderId,
            providerAccounts.length,
            providerAccounts.filter(a => a.status === 'active').length
          )
        }
        
        toast({
          title: t('providers.deleteSuccess'),
          description: t('providers.accountDeleted'),
        })
      }
    } catch (error) {
      toast({
        title: t('providers.deleteFailed'),
        description: error instanceof Error ? error.message : t('providers.operationFailed'),
        variant: 'destructive',
      })
    }
  }

  const handleValidateAccount = async (id: string) => {
    try {
      const isValid = await window.electronAPI.accounts.validate(id)
      if (isValid) {
        store.updateAccount(id, { status: 'active' })
        
        if (store.selectedProviderId) {
          const providerAccounts = store.getAccountsByProvider(store.selectedProviderId)
          store.updateAccountCount(
            store.selectedProviderId,
            providerAccounts.length,
            providerAccounts.filter(a => a.status === 'active').length
          )
        }
        
        toast({
          title: t('providers.validateSuccess'),
          description: t('providers.credentialsValid'),
        })
      } else {
        store.updateAccount(id, { status: 'error', errorMessage: t('providers.validateFailed') })
        
        if (store.selectedProviderId) {
          const providerAccounts = store.getAccountsByProvider(store.selectedProviderId)
          store.updateAccountCount(
            store.selectedProviderId,
            providerAccounts.length,
            providerAccounts.filter(a => a.status === 'active').length
          )
        }
        
        toast({
          title: t('providers.validateFailed'),
          description: (await window.electronAPI.accounts.getById(id))?.errorMessage || t('providers.credentialsInvalid'),
          variant: 'destructive',
        })
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : t('providers.operationFailed')
      store.updateAccount(id, { status: 'error', errorMessage })
      
      if (store.selectedProviderId) {
        const providerAccounts = store.getAccountsByProvider(store.selectedProviderId)
        store.updateAccountCount(
          store.selectedProviderId,
          providerAccounts.length,
          providerAccounts.filter(a => a.status === 'active').length
        )
      }
      
      toast({
        title: t('providers.validateFailed'),
        description: errorMessage,
        variant: 'destructive',
      })
    }
  }

  const handleValidateToken = async (providerId: string, credentials: Record<string, string>) => {
    return await window.electronAPI.accounts.validateToken(providerId, credentials)
  }

  const openAccountEditor = async (account: Account, returnToList = false) => {
    try {
      const fullAccount = await window.electronAPI.accounts.getById(account.id, true)
      setEditingAccount(fullAccount || account)
      if (returnToList) setViewMode('accounts')
      setShowAddAccountDialog(true)
    } catch (error) {
      toast({
        title: t('providers.operationFailed'),
        description: error instanceof Error ? error.message : t('common.error'),
        variant: 'destructive',
      })
    }
  }

  const handleViewAccountDetail = (account: Account) => {
    store.setSelectedAccountId(account.id)
    setViewMode('account-detail')
  }

  const handleBackToProviders = () => {
    setViewMode('providers')
    store.setSelectedProviderId(null)
    store.setSelectedAccountId(null)
  }

  const handleBackToAccounts = () => {
    setViewMode('accounts')
    store.setSelectedAccountId(null)
  }

  const stats = {
    total: sectionProviders.length,
    builtin: sectionProviders.filter(p => p.type === 'builtin').length,
    custom: sectionProviders.filter(p => p.type === 'custom').length,
    enabled: sectionProviders.filter(p => p.enabled).length,
    online: sectionProviders.filter(p => store.providerStatuses[p.id] === 'online').length,
  }

  if (store.isLoading) {
    return (
      <div className="flex items-center justify-center h-[50vh]">
        <div className="text-muted-foreground">{t('providers.loading')}</div>
      </div>
    )
  }

  const selectedProvider = store.selectedProviderId 
    ? store.getProviderById(store.selectedProviderId) 
    : null

  const selectedAccount = store.selectedAccountId 
    ? store.getAccountById(store.selectedAccountId) 
    : null

  const providerAccounts = store.selectedProviderId 
    ? store.getAccountsByProvider(store.selectedProviderId) 
    : []

  if (viewMode === 'account-detail' && selectedAccount && selectedProvider) {
    return (
      <div className="space-y-6">
        <AccountDetail
          account={selectedAccount}
          provider={selectedProvider}
          onBack={handleBackToAccounts}
          onEdit={() => { void openAccountEditor(selectedAccount, true) }}
          onDelete={() => handleDeleteAccount(selectedAccount.id)}
          onValidate={() => handleValidateAccount(selectedAccount.id)}
        />
      </div>
    )
  }

  if (viewMode === 'accounts' && selectedProvider) {
    return (
      <div className="space-y-6">
        <div className="space-y-3">
          <Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground" onClick={handleBackToProviders}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            {t('providers.backToProviderList')}
          </Button>

          <PageHeader
            icon={Server}
            title={`${selectedProvider.name} · ${t('providers.accountManagement')}`}
            description={t('providers.manageAllAccounts')}
          />
        </div>

        <AccountList
          accounts={providerAccounts}
          providerId={selectedProvider.id}
          onAddAccount={() => setShowAddAccountDialog(true)}
          onEditAccount={(account) => { void openAccountEditor(account) }}
          onDeleteAccount={handleDeleteAccount}
          onValidateAccount={handleValidateAccount}
          onViewDetail={handleViewAccountDetail}
        />

        <AddAccountDialog
          open={showAddAccountDialog}
          onOpenChange={(open) => {
            setShowAddAccountDialog(open)
            if (!open) setEditingAccount(null)
          }}
          provider={selectedProvider}
          onAddAccount={handleAddAccount}
          onValidateToken={handleValidateToken}
          editingAccount={editingAccount}
          onUpdateAccount={handleUpdateAccount}
        />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader icon={Server} title={t('providers.title')} description={t('providers.subtitle')} />

      <Tabs value={section} onValueChange={value => chooseSection(value as Section)}>
        <TabsList aria-label={t('providers.section.label')}>
          <TabsTrigger value="web" data-provider-section="web">{t('providers.section.web')} · {sectionCounts.web}</TabsTrigger>
          <TabsTrigger value="api" data-provider-section="api">{t('providers.section.api')} · {sectionCounts.api}</TabsTrigger>
        </TabsList>
      </Tabs>

      <ProviderFilter
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        typeFilter={typeFilter}
        onTypeFilterChange={setTypeFilter}
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
        onRefresh={handleCheckAllStatus}
        onAddProvider={() => section === 'api' ? setApiDialog({ open: true }) : setShowAddProviderDialog(true)}
        addLabel={section === 'api' ? t('providers.api.add') : undefined}
        isRefreshing={isRefreshing}
        stats={stats}
      />

      {section === 'api' && sectionProviders.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed py-12 text-center text-muted-foreground">
          <Server className="mb-3 h-10 w-10 opacity-50" />
          <p className="text-base font-medium text-foreground">{t('providers.api.empty')}</p>
          <p className="mt-1 max-w-lg text-sm">{t('providers.api.emptyHint')}</p>
          <Button className="mt-4" onClick={() => setApiDialog({ open: true })}>{t('providers.api.add')}</Button>
        </div>
      ) : filteredProviders.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed py-12 text-center text-muted-foreground">
          <Server className="mb-3 h-10 w-10 opacity-50" />
          <p className="text-base font-medium text-foreground">{t('providers.noProvidersFound')}</p>
          <p className="mt-1 text-sm">
            {searchQuery || typeFilter !== 'all' || statusFilter !== 'all'
              ? t('providers.tryAdjustingFilters')
              : t('providers.clickToAddProvider')}
          </p>
        </div>
      ) : (
        <div className="grid gap-4">
            {filteredProviders.map((provider) => (
              <ProviderCard
                key={provider.id}
                provider={provider}
                status={store.providerStatuses[provider.id]}
                accountCount={store.accountCounts[provider.id]?.total || 0}
                activeAccountCount={store.accountCounts[provider.id]?.active || 0}
                onToggle={handleToggleProvider}
                onEdit={handleEditProvider}
                onDelete={handleDeleteProvider}
                onDuplicate={handleDuplicateProvider}
                onCheckStatus={handleCheckProviderStatus}
                onManageAccounts={handleManageAccounts}
                onUpdateModels={handleUpdateModels}
                onManageModels={handleManageModels}
              />
            ))}
        </div>
      )}

      <AddApiProviderDialog
        open={apiDialog.open}
        initialPreset={apiDialog.preset}
        onOpenChange={open => setApiDialog(current => ({ ...current, open }))}
        providers={store.providers}
        onAdded={(result, name) => { void handleApiAdded(result, name).catch(error => toast({ title: t('common.error'), description: String(error), variant: 'destructive' })) }}
      />

      <AddProviderDialog
        open={showAddProviderDialog}
        onOpenChange={setShowAddProviderDialog}
        builtinProviders={store.builtinProviders}
        onSelectBuiltin={handleSelectBuiltinProvider}
        onCreateCustom={handleCreateCustomProvider}
        onValidateToken={handleValidateToken}
      />

      <CustomProviderForm
        open={showCustomProviderForm}
        onOpenChange={(open) => {
          setShowCustomProviderForm(open)
          if (!open) setEditingProvider(null)
        }}
        onSubmit={handleCustomProviderFormSubmit}
        initialData={editingProvider ? {
          name: editingProvider.name,
          authType: editingProvider.authType,
          apiEndpoint: editingProvider.apiEndpoint,
          headers: editingProvider.headers,
          description: editingProvider.description || '',
          supportedModels: editingProvider.supportedModels || [],
          credentialFields: editingProvider.credentialFields || [],
        } : undefined}
      />

      {modelEditorProvider && (
        <ModelEditor
          open={showModelEditor}
          onOpenChange={(open) => {
            setShowModelEditor(open)
            if (!open) setModelEditorProvider(null)
          }}
          providerId={modelEditorProvider.id}
          providerName={modelEditorProvider.name}
        />
      )}
    </div>
  )
}

export default Providers
