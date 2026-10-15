import { lstatSync } from 'node:fs'
import path from 'node:path'

// lstat also finds App Execution Aliases (Microsoft Store installs), which stat cannot read.
const present = (file: string) => { try { lstatSync(file); return true } catch { return false } }

/**
 * PowerShell for the Terminal panel. PowerShell 7 (pwsh) is preferred: it loads the user's pwsh profile and
 * a current PSReadLine with history predictions. Windows PowerShell 5.1 ships PSReadLine 2.0, which has
 * no predictions and reads a different profile, so it is only the fallback.
 */
export function findPowerShell(env: NodeJS.ProcessEnv = process.env, exists: (file: string) => boolean = present): { file: string; modern: boolean } | undefined {
  const value = (name: string) => Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1]
  const system = value('SYSTEMROOT') || 'C:\\Windows'
  const programFiles = [...new Set([value('PROGRAMFILES'), value('PROGRAMW6432'), 'C:\\Program Files'].filter((dir): dir is string => !!dir))]
  const modern = [
    ...programFiles.flatMap(dir => [path.win32.join(dir, 'PowerShell', '7', 'pwsh.exe'), path.win32.join(dir, 'PowerShell', '7-preview', 'pwsh.exe')]),
    ...(value('PATH') || '').split(';').filter(Boolean).map(dir => path.win32.join(dir, 'pwsh.exe')),
    ...(value('LOCALAPPDATA') ? [path.win32.join(value('LOCALAPPDATA')!, 'Microsoft', 'WindowsApps', 'pwsh.exe')] : []),
  ].find(exists)
  if (modern) return { file: modern, modern: true }
  const legacy = path.win32.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return exists(legacy) ? { file: legacy, modern: false } : undefined
}
