import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface StartupOptions {
  /** Enabled by default; software compositing is an explicit fallback for driver problems. */
  gpuCompositing: boolean
}

const file = () => join(homedir(), '.dailyworkmate', 'startup.json')

/** Read before Electron is ready, because Chromium switches cannot change later. Plain JSON, no secrets. */
export function readStartupOptions(target = file()): StartupOptions {
  try {
    const saved: unknown = JSON.parse(readFileSync(target, 'utf8'))
    if (saved && typeof saved === 'object' && 'gpuCompositing' in saved && typeof saved.gpuCompositing === 'boolean') {
      return { gpuCompositing: saved.gpuCompositing }
    }
    console.warn('[Startup] Invalid GPU compositing option; using the default')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[Startup] Unable to read startup options:', error)
  }
  return { gpuCompositing: true }
}

export function saveStartupOptions(value: StartupOptions, target = file()): StartupOptions {
  if (!value || typeof value !== 'object' || typeof value.gpuCompositing !== 'boolean') throw new Error('Invalid startup options')
  const next: StartupOptions = { gpuCompositing: value.gpuCompositing }
  mkdirSync(dirname(target), { recursive: true })
  const temporary = target + '.' + process.pid + '.tmp'
  writeFileSync(temporary, JSON.stringify(next, null, 2))
  renameSync(temporary, target)
  return next
}
