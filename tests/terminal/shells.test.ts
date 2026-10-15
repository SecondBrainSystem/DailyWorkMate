import test from 'node:test'
import assert from 'node:assert/strict'
import { findPowerShell } from '../../src/main/terminal/shells.ts'

const legacy = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const env = { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', Path: 'C:\\tools;C:\\scoop\\shims', LOCALAPPDATA: 'C:\\Users\\qa\\AppData\\Local' }

test('PowerShell 7 is preferred, wherever it was installed', () => {
  const installed = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
  assert.deepEqual(findPowerShell(env, file => file === installed || file === legacy), { file: installed, modern: true })
  const scoop = 'C:\\scoop\\shims\\pwsh.exe'
  assert.deepEqual(findPowerShell(env, file => file === scoop || file === legacy), { file: scoop, modern: true })
  const store = 'C:\\Users\\qa\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe'
  assert.deepEqual(findPowerShell(env, file => file === store || file === legacy), { file: store, modern: true })
})

test('Windows PowerShell 5.1 is the fallback; nothing installed means unavailable', () => {
  assert.deepEqual(findPowerShell(env, file => file === legacy), { file: legacy, modern: false })
  assert.equal(findPowerShell(env, () => false), undefined)
})
