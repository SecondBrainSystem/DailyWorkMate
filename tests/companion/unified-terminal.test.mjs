import test, { before } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
let validateTerminalCreate, validateTerminalPreferences
before(async () => {
  await mkdir('tmp/qa', { recursive: true })
  const file = path.resolve('tmp/qa/unified-terminal-boundaries.mjs')
  await build({ entryPoints: ['src/shared/terminal.ts'], outfile: file, bundle: true, platform: 'node', format: 'esm' })
  ;({ validateTerminalCreate, validateTerminalPreferences } = await import(pathToFileURL(file).href))
})
const input = { id: '12345678-1234-1234-1234-123456789abc', kind: 'cmd', directory: 'C:\\Projects', cols: 100, rows: 30 }
test('terminal IPC rejects invalid IDs, commands, dimensions, NUL paths and non-boolean preferences', () => {
  for (const value of [{ ...input, id: '../123' }, { ...input, kind: 'cmd.exe & delete' }, { ...input, cols: NaN }, { ...input, rows: 999 }, { ...input, directory: 'a\0b' }]) assert.throws(() => validateTerminalCreate(value))
  assert.throws(() => validateTerminalPreferences({ restoreOnStartup: true, keepRunningOnExit: 'true' }))
  assert.throws(() => validateTerminalCreate({ ...input, kind: 'opencode' }), /authorized folder/)
})
test('terminal requests contain only supported fields and cannot inject executable, environment or native server credentials', () => {
  assert.deepEqual(validateTerminalCreate({ ...input, file: 'bad.exe', args: ['bad'], env: { SECRET: 'bad' }, password: 'secret', opencode: { model: 'bad' } }), input)
  const native = validateTerminalCreate({ ...input, kind: 'opencode', opencode: { workspaceId: 'authorized', model: 'model', accessScope: 'folder', apiKey: 'secret', relativePath: 'subfolder' } })
  assert.equal(native.opencode.accessScope, 'folder')
  assert.ok(!JSON.stringify(native).includes('secret'))
  assert.throws(() => validateTerminalCreate({ ...input, kind: 'opencode', opencode: { workspaceId: 'authorized', model: 'model', accessScope: 'outside' } }))
})
