import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { AppConfig } from '@/types/electron'
import i18n from '@/i18n'
import { toast } from '@/hooks/use-toast'
import { DEFAULT_TYPOGRAPHY, normalizeTypography, type TypographySettings } from '../../../shared/typography'

let configWrites: Promise<unknown> = Promise.resolve()
let pendingConfigWrites = 0

export type Theme = 'light' | 'dark' | 'system'
export type Language = 'zh-CN' | 'en-US'
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type OAuthProxyMode = 'system' | 'none'

interface SettingsState {
  uiTypography: TypographySettings
  theme: Theme
  setTheme: (theme: Theme) => void
  sidebarCollapsed: boolean
  toggleSidebar: () => void
  setSidebarCollapsed: (collapsed: boolean) => void
  /** Fully hidden (not just collapsed to icons); toggled from the top bar. */
  sidebarHidden: boolean
  toggleSidebarHidden: () => void
  oauthProxyMode: OAuthProxyMode
  setOauthProxyMode: (mode: OAuthProxyMode) => void
  language: Language
  setLanguage: (language: Language) => void
  autoStart: boolean
  setAutoStart: (enabled: boolean) => void
  autoStartProxy: boolean
  setAutoStartProxy: (enabled: boolean) => void
  minimizeToTray: boolean
  setMinimizeToTray: (enabled: boolean) => void
  logLevel: LogLevel
  setLogLevel: (level: LogLevel) => void
  logRetentionDays: number
  setLogRetentionDays: (days: number) => void
  config: AppConfig | null
  setConfig: (config: AppConfig) => void
  isSaving: boolean
  updateConfig: (updates: Partial<AppConfig>) => Promise<boolean>
  fetchConfig: () => Promise<void>
}

export const SETTINGS_STORAGE_KEY = 'dailyworkmate-settings'
const THEMES: readonly Theme[] = ['light', 'dark', 'system']

/** Reads the theme from a persisted settings snapshot; anything malformed is ignored. */
export function themeFromPersistedSettings(raw: string | null): Theme | undefined {
  if (!raw) return undefined
  try {
    const theme = (JSON.parse(raw) as { state?: { theme?: unknown } } | null)?.state?.theme
    return THEMES.includes(theme as Theme) ? theme as Theme : undefined
  } catch (error) {
    console.warn('[Settings] Ignoring unreadable settings from another window:', error instanceof Error ? error.name : 'invalid data')
    return undefined
  }
}

/**
 * The tray and main windows share localStorage but each holds its own store, so a theme picked
 * in one window must be adopted by the other when its storage event arrives. Only the theme is
 * taken: a full rehydrate would reset the in-memory config.
 */
export function syncThemeAcrossWindows(target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window): () => void {
  const changed = (event: StorageEvent) => {
    if (event.key !== SETTINGS_STORAGE_KEY) return
    const theme = themeFromPersistedSettings(event.newValue)
    if (theme && theme !== useSettingsStore.getState().theme) useSettingsStore.setState({ theme })
  }
  target.addEventListener('storage', changed)
  return () => target.removeEventListener('storage', changed)
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      uiTypography: { ...DEFAULT_TYPOGRAPHY },
      theme: 'system',
      setTheme: (theme) => set({ theme }),
      sidebarCollapsed: false,
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
      sidebarHidden: false,
      toggleSidebarHidden: () => set((state) => ({ sidebarHidden: !state.sidebarHidden })),
      oauthProxyMode: 'system',
      setOauthProxyMode: (mode) => get().updateConfig({ oauthProxyMode: mode }),
      language: 'en-US',
      setLanguage: (language) => get().updateConfig({ language }),
      autoStart: false,
      setAutoStart: (enabled) => get().updateConfig({ autoStart: enabled }),
      autoStartProxy: false,
      setAutoStartProxy: (enabled) => get().updateConfig({ autoStartProxy: enabled }),
      minimizeToTray: true,
      setMinimizeToTray: (enabled) => get().updateConfig({ minimizeToTray: enabled }),
      logLevel: 'info',
      setLogLevel: (level) => get().updateConfig({ logLevel: level }),
      logRetentionDays: 30,
      setLogRetentionDays: (days) => get().updateConfig({ logRetentionDays: days }),
      config: null,
      isSaving: false,
      setConfig: (config) => {
        const language = config.language || 'en-US'
        set({
          config,
          uiTypography: normalizeTypography(config.uiTypography),
          autoStart: config.autoStart,
          autoStartProxy: config.autoStartProxy,
          minimizeToTray: config.minimizeToTray,
          logLevel: config.logLevel,
          logRetentionDays: config.logRetentionDays,
          oauthProxyMode: config.oauthProxyMode || 'system',
          language,
        })
        void i18n.changeLanguage(language)
      },
      updateConfig: (updates) => {
        pendingConfigWrites += 1
        set({ isSaving: true })
        const result = configWrites.then(async () => {
          try {
            if (!await window.electronAPI.config.update(updates)) {
              throw new Error(i18n.t('common.saveFailed'))
            }
            get().setConfig(await window.electronAPI.config.get())
            return true
          } catch (error) {
            console.error('Failed to update config:', error)
            toast({
              title: i18n.t('common.error'),
              description: error instanceof Error ? error.message : i18n.t('common.saveFailed'),
              variant: 'destructive',
            })
            return false
          } finally {
            pendingConfigWrites -= 1
            set({ isSaving: pendingConfigWrites > 0 })
          }
        })
        configWrites = result.catch(() => undefined)
        return result
      },
      fetchConfig: async () => {
        await configWrites
        try {
          get().setConfig(await window.electronAPI.config.get())
        } catch (error) {
          console.error('Failed to fetch config:', error)
        }
      },
    }),
    {
      name: SETTINGS_STORAGE_KEY,
      partialize: ({ theme, language, uiTypography, sidebarCollapsed, sidebarHidden }) => ({ theme, language, uiTypography, sidebarCollapsed, sidebarHidden }),
      merge: (persisted, current) => ({ ...current, ...persisted as Partial<SettingsState>,
        config: null, uiTypography: normalizeTypography((persisted as Partial<SettingsState> | undefined)?.uiTypography), isSaving: false }),
      onRehydrateStorage: () => (state) => {
        if (state?.language) {
          i18n.changeLanguage(state.language)
        }
      },
    }
  )
)
