import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { FeatureMode, ModelFeatureDefaults } from '../../../../shared/modelFeatures'

export function ModelFeatureControls({ value, onChange, disabled = false, compact = false }: {
  value: ModelFeatureDefaults
  onChange: (value: ModelFeatureDefaults) => void
  disabled?: boolean
  /** Short labels and narrow selects for toolbars; the full label stays as tooltip and accessible name. */
  compact?: boolean
}) {
  const { t } = useTranslation()
  const id = useId()
  return <div className={compact ? 'flex flex-wrap items-center gap-x-3 gap-y-2' : 'flex flex-wrap items-center gap-x-5 gap-y-3'}>
    {(['vision', 'thinking'] as const).map(feature => <div key={feature} className="flex min-w-0 flex-wrap items-center gap-2" title={compact ? t(`modelFeatures.${feature}`) : undefined}>
      <Label htmlFor={`${id}-${feature}`} className="whitespace-nowrap">{compact ? t(`modelFeatures.${feature}Short`) : t(`modelFeatures.${feature}`)}</Label>
      <Select value={value[feature]} onValueChange={mode => onChange({ ...value, [feature]: mode as FeatureMode })} disabled={disabled}>
        <SelectTrigger id={`${id}-${feature}`} className={compact ? 'w-[5.75rem]' : 'w-32'} aria-label={compact ? t(`modelFeatures.${feature}`) : undefined}><SelectValue /></SelectTrigger>
        <SelectContent>
          {(['auto', 'enabled', 'disabled'] as const).map(mode => <SelectItem key={mode} value={mode}>{t(`modelFeatures.${mode}`)}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>)}
  </div>
}
