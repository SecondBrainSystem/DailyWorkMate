import { useShallow } from 'zustand/react/shallow'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SlidersHorizontal } from 'lucide-react'
import { Card, CardContent, CardHeading } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useProxyStore } from '@/stores/proxyStore'
import { ModelFeatureControls } from './ModelFeatureControls'
import { normalizeModelFeatureDefaults } from '../../../../shared/modelFeatures'

export function ModelFeatureConfig() {
  const { t } = useTranslation()
  const { appConfig, setAppConfig } = useProxyStore(useShallow(state => ({ appConfig: state.appConfig, setAppConfig: state.setAppConfig })))
  const [value, setValue] = useState(() => normalizeModelFeatureDefaults(appConfig?.modelFeatureDefaults))
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<{ text: string; ok: boolean } | null>(null)
  useEffect(() => { setValue(normalizeModelFeatureDefaults(appConfig?.modelFeatureDefaults)) }, [appConfig?.modelFeatureDefaults])
  const save = async () => {
    setSaving(true)
    setStatus(null)
    try {
      const success = await window.electronAPI.config.update({ modelFeatureDefaults: value })
      if (success) setAppConfig(await window.electronAPI.config.get())
      setStatus({ text: t(success ? 'modelFeatures.saved' : 'modelFeatures.saveFailed'), ok: !!success })
    } catch (error) {
      console.error('Failed to save model feature defaults:', error)
      setStatus({ text: t('modelFeatures.saveFailed'), ok: false })
    } finally { setSaving(false) }
  }
  return <Card>
    <CardHeading icon={SlidersHorizontal} title={t('modelFeatures.defaultsTitle')} description={t('modelFeatures.defaultsHint')} />
    <CardContent className="space-y-4">
      <div className="space-y-3 rounded-xl border bg-muted/40 p-4">
        <ModelFeatureControls value={value} onChange={setValue} disabled={saving || !appConfig} />
        <p className="text-[0.8125rem] leading-relaxed text-muted-foreground">{t('modelFeatures.capabilityHint')}</p>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-3 border-t pt-4">
        <span role="status" className={cn('text-sm', status ? (status.ok ? 'text-success' : 'text-destructive') : 'text-muted-foreground')}>{status?.text ?? ''}</span>
        <Button onClick={() => void save()} disabled={saving || !appConfig}>{t('common.save')}</Button>
      </div>
    </CardContent>
  </Card>
}
