import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, ExternalLink, Eye, EyeOff, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { providerIcons } from '@/lib/providerIcons'
import { cn } from '@/lib/utils'
import { API_PRESETS, CUSTOM_API_PRESET, apiPreset, type ApiPreset, type ApiProviderResult } from '../../../../shared/apiProviders'
import type { Provider } from '@/types/electron'

/** Letter badge for vendors without an icon in the app. */
export function ApiProviderIcon({ preset, name, className }: { preset?: string; name: string; className?: string }) {
  const icon = providerIcons[apiPreset(preset)?.icon || '']
  if (icon) return <img src={icon} alt="" className={cn('h-7 w-7 object-contain', className)} />
  const hue = [...(preset || name)].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 360
  return <span aria-hidden="true" className={cn('grid h-7 w-7 place-items-center rounded-lg text-sm font-semibold text-white', className)} style={{ background: `hsl(${hue} 55% 45%)` }}>{name.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 1).toUpperCase()}</span>
}

export const apiPresetName = (preset: ApiPreset, chinese: boolean) => preset.id === CUSTOM_API_PRESET ? (chinese ? '自定义接口' : 'Custom endpoint') : preset.name

/**
 * Add an official API key: pick a vendor, paste the key. The key is verified by reading the vendor's
 * model list. A vendor that is already set up gets the key as another account.
 */
export function AddApiProviderDialog({ open, onOpenChange, providers, initialPreset, onAdded }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  providers: Provider[]
  /** Open straight on a vendor's form, e.g. to add another key. */
  initialPreset?: string
  onAdded: (result: ApiProviderResult, name: string) => void
}) {
  const { t, i18n } = useTranslation()
  const chinese = i18n.language.startsWith('zh')
  const [presetId, setPresetId] = useState('')
  const [regionId, setRegionId] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [baseUrl, setBaseUrl] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const preset = apiPreset(presetId)
  const custom = presetId === CUSTOM_API_PRESET
  const region = preset?.regions.find(item => item.id === regionId) ?? preset?.regions[0]
  const configured = useMemo(() => new Set(providers.filter(provider => provider.upstreamKind === 'api').map(provider => provider.apiPreset)), [providers])
  const existing = preset && !custom ? providers.find(provider => provider.id === 'api-' + preset.id) : undefined

  useEffect(() => {
    if (!open) return
    setPresetId(initialPreset || ''); setRegionId(''); setApiKey(''); setShowKey(false); setBaseUrl(''); setName(''); setError(''); setBusy(false)
  }, [open, initialPreset])
  // A vendor that is already set up keeps its address; new keys join it.
  useEffect(() => { if (existing) { setBaseUrl(existing.apiEndpoint); setRegionId(apiPreset(existing.apiPreset)?.regions.find(item => item.baseUrl === existing.apiEndpoint)?.id || '') } }, [existing?.id])

  const submit = async () => {
    if (!preset || busy) return
    setBusy(true); setError('')
    try {
      const result = await window.electronAPI.app.addApiProvider({ presetId: preset.id, regionId: region?.id, apiKey, ...(baseUrl.trim() && baseUrl.trim() !== region?.baseUrl ? { baseUrl: baseUrl.trim() } : {}), ...(custom ? { name } : {}) })
      onAdded(result, custom ? (name.trim() || baseUrl) : apiPresetName(preset, chinese))
      onOpenChange(false)
    } catch (failure) { setError(failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(failure)) }
    finally { setBusy(false) }
  }

  return <Dialog open={open} onOpenChange={next => { if (!busy) onOpenChange(next) }}>
    <DialogContent className="max-h-[88vh] max-w-2xl overflow-y-auto">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          {preset && !initialPreset && <Button variant="ghost" size="icon" className="-ml-2 h-8 w-8" disabled={busy} onClick={() => { setPresetId(''); setError('') }} aria-label={t('common.back')}><ArrowLeft className="h-4 w-4" /></Button>}
          {preset ? apiPresetName(preset, chinese) : t('providers.api.add')}
        </DialogTitle>
        <DialogDescription>{preset ? existing ? t('providers.api.existing') : preset.protocol === 'anthropic' ? t('providers.api.claudeProtocol') : t('providers.api.openaiCompatible') : t('providers.api.chooseHint')}</DialogDescription>
      </DialogHeader>

      {!preset ? <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="list">
        {API_PRESETS.map(item => <button key={item.id} type="button" role="listitem" data-api-preset={item.id} onClick={() => setPresetId(item.id)}
          className="flex items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-muted/60">
          <ApiProviderIcon preset={item.id} name={apiPresetName(item, chinese)} />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{apiPresetName(item, chinese)}</span>
            <span className="block truncate text-xs text-muted-foreground">{configured.has(item.id) && item.id !== CUSTOM_API_PRESET ? t('providers.api.configured') : item.protocol === 'anthropic' ? 'Messages API' : 'OpenAI API'}</span>
          </span>
        </button>)}
      </div> : <form className="grid gap-4" onSubmit={event => { event.preventDefault(); void submit() }}>
        {custom && <div className="grid gap-2">
          <Label htmlFor="api-name">{t('providers.api.name')}</Label>
          <Input id="api-name" value={name} maxLength={50} placeholder={t('providers.api.namePlaceholder')} onChange={event => setName(event.target.value)} />
        </div>}
        {custom && <div className="grid gap-2">
          <Label htmlFor="api-base-url">{t('providers.api.baseUrl')}</Label>
          <Input id="api-base-url" value={baseUrl} required placeholder="https://example.com/v1" onChange={event => setBaseUrl(event.target.value)} />
        </div>}
        {!custom && preset.regions.length > 1 && !existing && <div className="grid gap-2">
          <Label>{t('providers.api.region')}</Label>
          <Select value={region?.id} onValueChange={value => { setRegionId(value); setBaseUrl('') }}>
            <SelectTrigger aria-label={t('providers.api.region')}><SelectValue /></SelectTrigger>
            <SelectContent>{preset.regions.map(item => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectContent>
          </Select>
        </div>}
        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="api-key">API Key</Label>
            {region && <button type="button" className="inline-flex items-center gap-1 text-xs text-primary hover:underline" onClick={() => { void window.electronAPI.app.openExternal(region.keyUrl) }}>{t('providers.api.getKey')}<ExternalLink className="h-3 w-3" /></button>}
          </div>
          <div className="relative">
            <Input id="api-key" type={showKey ? 'text' : 'password'} value={apiKey} required autoComplete="off" spellCheck={false} placeholder={preset.keyPlaceholder || 'API key'} className="pr-10" onChange={event => setApiKey(event.target.value)} />
            <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground" aria-label={showKey ? t('providers.api.hideKey') : t('providers.api.showKey')} onClick={() => setShowKey(value => !value)}>{showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button>
          </div>
        </div>
        {!custom && !existing && <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">{t('providers.api.advanced')}</summary>
          <div className="mt-3 grid gap-2">
            <Label htmlFor="api-base-override">{t('providers.api.baseUrl')}</Label>
            <Input id="api-base-override" value={baseUrl || region?.baseUrl || ''} onChange={event => setBaseUrl(event.target.value)} />
          </div>
        </details>}
        {/* The vendor's own message says what is wrong with the key or address. */}
        {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button type="submit" disabled={busy || !apiKey.trim() || (custom && !baseUrl.trim())}>
            {busy && <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />}{busy ? t('providers.api.verifying') : t('providers.api.verifyAndAdd')}
          </Button>
        </DialogFooter>
      </form>}
    </DialogContent>
  </Dialog>
}
