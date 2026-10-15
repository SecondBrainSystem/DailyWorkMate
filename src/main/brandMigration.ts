import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Copy once, atomically, and never remove or overwrite the previous application's data. */
export function migrateDirectory(source: string, target: string): boolean {
  if (existsSync(target) || !existsSync(source)) return false
  mkdirSync(dirname(target), { recursive: true })
  const staging = mkdtempSync(join(dirname(target), '.dailyworkmate-migration-'))
  cpSync(source, staging, { recursive: true, errorOnExist: true, force: false })
  renameSync(staging, target)
  return true
}

export function migrateApplicationData(home: string, appData: string, userData: string): void {
  migrateDirectory(join(home, '.chat2api'), join(home, '.dailyworkmate'))
  migrateDirectory(join(appData, 'chat2api'), userData)
}

export function legacyEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).flatMap(([key, value]) => {
    if (!key.startsWith('CHAT2API_')) return [[key, value]]
    const next = key.replace(/^CHAT2API_/, 'DAILYWORKMATE_')
    return [[key, value], ...(env[next] === undefined ? [[next, value]] : [])]
  }))
}
