import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

interface CommitNumberInputProps extends Omit<React.ComponentProps<typeof Input>, 'value' | 'onChange' | 'type' | 'min' | 'max'> {
  value: number
  min: number
  max: number
  /** Called once with a valid integer when the field loses focus or Enter is pressed. */
  onCommit: (value: number) => void | Promise<unknown>
}

/**
 * A whole-number setting that is validated and saved when editing finishes,
 * instead of writing the config on every keystroke. Escape restores the saved value.
 */
export function CommitNumberInput({ value, min, max, onCommit, className, id, ...props }: CommitNumberInputProps) {
  const { t } = useTranslation()
  const [draft, setDraft] = React.useState(String(value))
  const errorId = id ? `${id}-error` : undefined

  React.useEffect(() => { setDraft(String(value)) }, [value])

  const parsed = Number(draft)
  const valid = draft.trim() !== '' && Number.isInteger(parsed) && parsed >= min && parsed <= max

  const commit = () => {
    if (!valid) return
    if (parsed !== value) void onCommit(parsed)
  }

  return (
    <div className="space-y-1">
      <Input
        {...props}
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={draft}
        aria-invalid={!valid}
        aria-describedby={!valid ? errorId : undefined}
        className={cn(!valid && 'border-destructive focus-visible:border-destructive focus-visible:ring-destructive/20', className)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit()
          if (event.key === 'Escape') setDraft(String(value))
        }}
      />
      {!valid && (
        <p id={errorId} className="text-xs text-destructive">
          {t('common.invalidNumber', { min, max })}
        </p>
      )}
    </div>
  )
}
