import { useEffect, useState } from 'react'
import { useSettingsStore } from '@/stores/settingsStore'

const DARK_QUERY = '(prefers-color-scheme: dark)'

/** Reads the theme preference; ThemeProvider is the one place that applies it to the document. */
export function useTheme() {
  const { theme, setTheme } = useSettingsStore()
  const [systemDark, setSystemDark] = useState(() => window.matchMedia(DARK_QUERY).matches)

  useEffect(() => {
    const query = window.matchMedia(DARK_QUERY)
    const update = () => setSystemDark(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  const isDark = theme === 'system' ? systemDark : theme === 'dark'

  const toggleTheme = () => {
    setTheme(isDark ? 'light' : 'dark')
  }

  return {
    theme,
    setTheme,
    toggleTheme,
    isDark,
  }
}
