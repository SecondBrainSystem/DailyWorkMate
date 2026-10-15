import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

const CJK = /[㐀-鿿豈-﫿]/

/**
 * Main-process messages are often bilingual: "中文说明。 / English text." Show only the
 * half that matches the UI language; text that is not split that way is returned as is.
 */
export function localizeBilingual(text: string, chinese: boolean): string {
  let from = 0
  for (;;) {
    const index = text.indexOf(' / ', from)
    if (index < 0) return text
    const left = text.slice(0, index).trim()
    const right = text.slice(index + 3).trim()
    // The split point is where the Chinese half ends and an English-only half begins.
    if (CJK.test(left) && right && !CJK.test(right) && /^[A-Za-z0-9"'(]/.test(right)) return chinese ? left : right
    from = index + 3
  }
}

/** The readable message of any thrown value, without IPC wrappers or "Error:" prefixes. */
export function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message
    : typeof error === 'string' ? error
      : error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string' ? (error as { message: string }).message
        : String(error ?? '')
  return raw
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^(?:(?:[A-Z][A-Za-z]*)?Error:\s*)+/, '')
    .trim()
}

/** User-facing error text: unwrapped and in the UI language. `fallback` covers empty messages. */
export function errorText(error: unknown, chinese: boolean, fallback = ''): string {
  return localizeBilingual(errorMessage(error), chinese) || fallback
}

/** `errorText` bound to the current UI language. */
export function useErrorText() {
  const { i18n } = useTranslation()
  const chinese = (i18n.resolvedLanguage || i18n.language || '').startsWith('zh')
  return useCallback((error: unknown, fallback = '') => errorText(error, chinese, fallback), [chinese])
}
