import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface StartupOptions {
  /** GPU compositing costs ~120–150 MB in the GPU process; software compositing keeps 60 fps here, including the 3D avatar. */
  gpuCompositing: boolean
}

const file = () => join(homedir(), '.dailyworkmate', 'startup.json')

/** Read before Electron is ready, because Chromium switches cannot change later. Plain JSON, no secrets. */
export function readStartupOptions(): StartupOptions {
  try { return { gpuCompositing: JSON.parse(readFileSync(file(), 'utf8'))?.gpuCompositing === true } }
  catch { return { gpuCompositing: false } }
}

export function saveStartupOptions(value: StartupOptions): StartupOptions {
  if (!value || typeof value !== 'object' || typeof value.gpuCompositing !== 'boolean') throw new Error('Invalid startup options')
  const next: StartupOptions = { gpuCompositing: value.gpuCompositing }
  const target = file()
  mkdirSync(dirname(target), { recursive: true })
  const temporary = target + '.' + process.pid + '.tmp'
  writeFileSync(temporary, JSON.stringify(next, null, 2))
  renameSync(temporary, target)
  return next
}
