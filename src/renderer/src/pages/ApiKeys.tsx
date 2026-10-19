import { useShallow } from 'zustand/react/shallow'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LoadError } from '@/components/ui/load-error'
import { Card, CardContent, CardHeading } from '@/components/ui/card'
import { SettingList, SettingRow } from '@/components/ui/setting-row'
import { ManagementApiSettings } from '@/components/settings'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'

import { 
  Key, 
  Plus, 
  Copy, 
  Trash2, 
  Eye, 
  EyeOff,
  Shield,
  Clock,
  BarChart3,
} from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { toast } from '@/hooks/use-toast'
import { useSettingsStore } from '@/stores/settingsStore'
import type { ApiKey } from '@/types/electron'

function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return 'sk-' + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

function generateId(): string {
  return crypto.randomUUID()
}

export default function ApiKeysPage() {
  const { t, i18n } = useTranslation()
  const { config, updateConfig, isSaving } = useSettingsStore(useShallow(state => ({ config: state.config, updateConfig: state.updateConfig, isSaving: state.isSaving })))
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [newKeyName, setNewKeyName] = useState('')
  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(new Set())
  const [deleteKeyId, setDeleteKeyId] = useState<string | null>(null)

  const [loadError, setLoadError] = useState('')
  useEffect(() => {
    let active = true
    const refresh = async () => { if (document.hidden || useSettingsStore.getState().isSaving) return; try { const config = await window.electronAPI.config.get(); if (active) { useSettingsStore.getState().setConfig(config); setLoadError('') } } catch (error) { if (active) setLoadError(String(error)) } }
    void refresh(); const timer = setInterval(() => void refresh(), 5000); window.addEventListener('focus', refresh)
    return () => { active = false; clearInterval(timer); window.removeEventListener('focus', refresh) }
  }, [])

  const apiKeys = config?.apiKeys || []

  const updateKeys = async (transform: (keys: ApiKey[]) => ApiKey[]) => {
    try {
      const latest = await window.electronAPI.config.get()
      const saved = await updateConfig({ apiKeys: transform(latest.apiKeys) })
      if (saved) setLoadError('')
      return saved
    } catch (error) { setLoadError(String(error)); return false }
  }

  const handleToggleEnabled = async (keyId: string, enabled: boolean) => {
    if (!await updateKeys(keys => keys.map(k => k.id === keyId ? { ...k, enabled } : k))) return
    toast({
      title: enabled ? t('apiKeys.keyEnabled') : t('apiKeys.keyDisabled'),
    })
  }

  const handleAddKey = async () => {
    if (!newKeyName.trim()) {
      toast({
        title: t('apiKeys.pleaseEnterName'),
        description: t('apiKeys.keyNameRequired'),
        variant: 'destructive',
      })
      return
    }

    const newKey: ApiKey = {
      id: generateId(),
      name: newKeyName.trim(),
      key: generateApiKey(),
      enabled: true,
      createdAt: Date.now(),
      usageCount: 0,
    }

    if (!await updateKeys(keys => [...keys, newKey])) return
    setShowAddDialog(false)
    setNewKeyName('')
  }

  const handleDeleteKey = async () => {
    if (!deleteKeyId) return
    
    if (!await updateKeys(keys => keys.filter(k => k.id !== deleteKeyId))) return
    setDeleteKeyId(null)
    toast({
      title: t('apiKeys.deleted'),
      description: t('apiKeys.keyDeleted'),
    })
  }

  const handleCopyKey = async (key: string) => {
    try {
      await navigator.clipboard.writeText(key)
      toast({
        title: t('apiKeys.copied'),
        description: t('apiKeys.copiedToClipboard'),
      })
    } catch (error) {
      toast({
        title: t('common.error'),
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      })
    }
  }

  const handleToggleVisibility = (keyId: string) => {
    const newVisible = new Set(visibleKeys)
    if (newVisible.has(keyId)) {
      newVisible.delete(keyId)
    } else {
      newVisible.add(keyId)
    }
    setVisibleKeys(newVisible)
  }

  const handleToggleGlobalEnabled = async (enabled: boolean) => {
    if (!await updateConfig({ enableApiKey: enabled })) return
    toast({
      title: enabled ? t('apiKeys.authEnabled') : t('apiKeys.authDisabled'),
    })
  }

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleString(i18n.language, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  const maskKey = (key: string) => {
    if (key.length <= 10) return key
    return key.substring(0, 7) + '****' + key.substring(key.length - 4)
  }

  return (
    <div className="space-y-6">
      {loadError && <LoadError message={loadError} onRetry={() => void useSettingsStore.getState().fetchConfig()} />}
      <PageHeader icon={Key} title={t('apiKeys.title')} description={t('apiKeys.description')} />

      <Card>
        <CardHeading
          icon={Shield}
          title={t('apiKeys.apiKeyList')}
          description={t('apiKeys.apiKeyAuthDesc')}
          actions={
            <Button onClick={() => setShowAddDialog(true)}>
              <Plus className="h-4 w-4 mr-2" />
              {t('apiKeys.newApiKey')}
            </Button>
          }
        />
        <CardContent className="space-y-4">
          <SettingList>
            <SettingRow
              label={t('apiKeys.enableApiKeyAuth')}
              htmlFor="global-enable"
              description={`${t('apiKeys.totalKeys', { count: apiKeys.length })}, ${t('apiKeys.enabledKeys', { count: apiKeys.filter(k => k.enabled).length })}`}
            >
              <Switch disabled={isSaving || !config}
                id="global-enable"
                checked={config?.enableApiKey || false}
                onCheckedChange={handleToggleGlobalEnabled}
              />
            </SettingRow>
          </SettingList>

          {apiKeys.length === 0 ? (
            <div className="rounded-xl border border-dashed py-10 text-center">
              <Key className="mx-auto mb-3 h-10 w-10 text-muted-foreground/60" />
              <p className="text-sm font-medium">{t('apiKeys.noApiKeys')}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t('apiKeys.clickToCreate')}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableHead>{t('apiKeys.name')}</TableHead>
                    <TableHead>{t('apiKeys.apiKey')}</TableHead>
                    <TableHead>{t('apiKeys.status')}</TableHead>
                    <TableHead>{t('apiKeys.usageCount')}</TableHead>
                    <TableHead>{t('apiKeys.createdAt')}</TableHead>
                    <TableHead className="text-right">{t('apiKeys.operations')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {apiKeys.map((apiKey) => (
                    <TableRow key={apiKey.id}>
                      <TableCell>
                        <div className="font-medium">{apiKey.name}</div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <code className="rounded-md bg-muted px-2 py-1 font-mono text-[0.8125rem]">
                            {visibleKeys.has(apiKey.id)
                              ? apiKey.key
                              : maskKey(apiKey.key)}
                          </code>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => handleToggleVisibility(apiKey.id)}
                            aria-label={visibleKeys.has(apiKey.id) ? t('apiKeys.hideKey') : t('apiKeys.showKey')}
                            title={visibleKeys.has(apiKey.id) ? t('apiKeys.hideKey') : t('apiKeys.showKey')}
                          >
                            {visibleKeys.has(apiKey.id) ? (
                              <EyeOff className="h-4 w-4" />
                            ) : (
                              <Eye className="h-4 w-4" />
                            )}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => handleCopyKey(apiKey.key)}
                            aria-label={t('apiKeys.copyKey')}
                            title={t('apiKeys.copyKey')}
                          >
                            <Copy className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Switch disabled={isSaving || !config}
                          checked={apiKey.enabled}
                          aria-label={`${apiKey.name}: ${apiKey.enabled ? t('common.enabled') : t('common.disabled')}`}
                          onCheckedChange={(checked) =>
                            handleToggleEnabled(apiKey.id, checked)
                          }
                        />
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5 tabular-nums">
                          <BarChart3 className="h-4 w-4 text-muted-foreground" />
                          {apiKey.usageCount}<div className="mt-1 text-xs text-muted-foreground">{apiKey.lastUsedAt ? new Date(apiKey.lastUsedAt).toLocaleString(i18n.language) : t('apiKeys.neverUsed')}</div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5 text-sm text-muted-foreground tabular-nums">
                          <Clock className="h-4 w-4" />
                          {formatDate(apiKey.createdAt)}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10"
                          onClick={() => setDeleteKeyId(apiKey.id)}
                          aria-label={`${t('apiKeys.delete')} ${apiKey.name}`}
                          title={t('apiKeys.delete')}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <ManagementApiSettings />

      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('apiKeys.createApiKey')}</DialogTitle>
            <DialogDescription>
              {t('apiKeys.createApiKeyDesc')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="key-name">{t('apiKeys.keyName')}</Label>
              <Input
                id="key-name"
                placeholder={t('apiKeys.keyNamePlaceholder')}
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddDialog(false)}>
              {t('apiKeys.cancel')}
            </Button>
            <Button onClick={handleAddKey} disabled={isSaving || !config}>
              {t('apiKeys.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleteKeyId}
        onOpenChange={open => { if (!open) setDeleteKeyId(null) }}
        destructive
        busy={isSaving}
        title={t('apiKeys.confirmDelete')}
        description={t('apiKeys.confirmDeleteDesc')}
        cancelLabel={t('apiKeys.cancel')}
        confirmLabel={t('apiKeys.delete')}
        onConfirm={handleDeleteKey}
      />
    </div>
  )
}
