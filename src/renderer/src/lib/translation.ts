/** Target languages offered by translation tasks. `auto` keeps the task's own rule (Chinese ↔ English). */
export const TRANSLATION_TARGETS = [
  { id: 'auto', label: '', name: '' },
  { id: 'zh-CN', label: '简体中文', name: 'Simplified Chinese (简体中文)' },
  { id: 'zh-TW', label: '繁體中文', name: 'Traditional Chinese (繁體中文)' },
  { id: 'en', label: 'English', name: 'English' },
  { id: 'de', label: 'Deutsch', name: 'German (Deutsch)' },
  { id: 'fr', label: 'Français', name: 'French (Français)' },
  { id: 'es', label: 'Español', name: 'Spanish (Español)' },
  { id: 'ja', label: '日本語', name: 'Japanese (日本語)' },
  { id: 'ko', label: '한국어', name: 'Korean (한국어)' },
  { id: 'ru', label: 'Русский', name: 'Russian (Русский)' },
  { id: 'it', label: 'Italiano', name: 'Italian (Italiano)' },
  { id: 'pt', label: 'Português', name: 'Portuguese (Português)' },
] as const
export type TranslationTarget = typeof TRANSLATION_TARGETS[number]['id']

export const isTranslationTarget = (value: unknown): value is TranslationTarget => TRANSLATION_TARGETS.some(target => target.id === value)

/** The task prompt with an explicit target language appended; `auto` leaves the prompt unchanged. */
export function withTranslationTarget(prompt: string, target: TranslationTarget): string {
  const language = TRANSLATION_TARGETS.find(item => item.id === target)
  if (!language || target === 'auto') return prompt
  return (prompt ? prompt + '\n\n' : '') + 'Target language: ' + language.name + '. Translate the user content into ' + language.name
    + ' whatever its source language. If the content is already entirely in ' + language.name + ', return it unchanged.'
}

const DEFAULT_KEY = 'dailyworkmate.chat.translationTarget'
/** The target picked last, used for new translation conversations on this device. */
export function lastTranslationTarget(): TranslationTarget {
  try { const saved = localStorage.getItem(DEFAULT_KEY); return isTranslationTarget(saved) ? saved : 'auto' } catch { return 'auto' }
}
export function rememberTranslationTarget(target: TranslationTarget) {
  try { localStorage.setItem(DEFAULT_KEY, target) } catch { /* per-device convenience only */ }
}
