import { useTranslation } from 'react-i18next'

/** True when the UI renders in Chinese. Reads i18next (not the settings store) so it follows the language actually shown. */
export function isChineseLanguage(language: string | undefined): boolean {
  return (language || '').toLowerCase().startsWith('zh')
}

export function useIsChinese(): boolean {
  const { i18n } = useTranslation()
  return isChineseLanguage(i18n.resolvedLanguage || i18n.language)
}
