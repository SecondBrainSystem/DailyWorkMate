import { readFileSync } from 'node:fs'
import i18n from 'i18next'

const load = (language: string) => JSON.parse(readFileSync(new URL(`../../src/renderer/src/i18n/locales/${language}.json`, import.meta.url), 'utf8'))

/** Renderer modules translate their errors through the shared i18next instance, which the app initializes at startup. */
export const i18nReady = i18n.init({
  lng: 'en-US', fallbackLng: 'en-US', interpolation: { escapeValue: false }, showSupportNotice: false,
  resources: { 'en-US': { translation: load('en-US') }, 'zh-CN': { translation: load('zh-CN') } },
})
