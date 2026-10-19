import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import enUS from '@/i18n/locales/en-US.json'
import zhCN from '@/i18n/locales/zh-CN.json'

/** The `companion` locale namespace as one object, for components that pass their strings around. */
export type CompanionCopy = typeof enUS.companion

/** Static snapshots of the locale files for harnesses that render without i18next. */
export const companionCopy: { zh: CompanionCopy; en: CompanionCopy } = { zh: zhCN.companion, en: enUS.companion }

/** `companion.*` in the current UI language; stable until the language changes so memoized children keep working. */
export function useCompanionCopy(): CompanionCopy {
  const { t } = useTranslation()
  return useMemo(() => t('companion', { returnObjects: true }) as unknown as CompanionCopy, [t])
}
