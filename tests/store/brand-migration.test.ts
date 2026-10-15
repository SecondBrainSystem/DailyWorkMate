import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Conf from 'conf'
import { legacyEnvironment, migrateDirectory } from '../../src/main/brandMigration.ts'
import { migrateLocalStorage } from '../../src/renderer/src/lib/brandMigration.ts'

test('rebranding preserves encrypted credentials and original files without overwriting new data', () => {
  const root = mkdtempSync(join(tmpdir(), 'dailyworkmate-migration-test-'))
  try {
    const source = join(root, 'old'), target = join(root, 'new')
    const options = { projectName: 'migration-test', configName: 'data', encryptionKey: 'chat2api-fixed-encryption-key-v1' }
    const original = new Conf({ ...options, cwd: source })
    original.set('accounts', [{ id: 'test-account', credentials: 'test-value' }])
    mkdirSync(join(source, 'logs')); writeFileSync(join(source, 'logs/example.txt'), 'old log')
    const before = readFileSync(join(source, 'data.json'))
    assert.equal(migrateDirectory(source, target), true)
    assert.deepEqual(new Conf({ ...options, cwd: target }).get('accounts'), original.get('accounts'))
    assert.deepEqual(readFileSync(join(source, 'data.json')), before)
    writeFileSync(join(target, 'logs/example.txt'), 'new log')
    assert.equal(migrateDirectory(source, target), false)
    assert.equal(readFileSync(join(target, 'logs/example.txt'), 'utf8'), 'new log')
    assert.equal(migrateDirectory(join(root, 'missing'), join(root, 'absent')), false)
    assert.equal(existsSync(join(root, 'absent')), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('legacy environment aliases respect explicit DailyWorkMate overrides', () => {
  const original = { CHAT2API_COMPANION_HOME: 'old', CHAT2API_CLAUDE_PATH: 'claude', DAILYWORKMATE_COMPANION_HOME: 'new' }
  assert.deepEqual(legacyEnvironment(original), { ...original, DAILYWORKMATE_CLAUDE_PATH: 'claude' })
  assert.equal(Object.hasOwn(original, 'DAILYWORKMATE_CLAUDE_PATH'), false)
})

test('renderer migration retains original settings and never overwrites new settings', () => {
  const entries = new Map([['chat2api-settings', 'old'], ['dailyworkmate-settings', 'new'], ['chat2api.companion.view', 'terminal'], ['unrelated', 'value']])
  const storage = { get length() { return entries.size }, key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => entries.set(key, value) } as unknown as Storage
  migrateLocalStorage(storage)
  assert.equal(entries.get('dailyworkmate-settings'), 'new')
  assert.equal(entries.get('dailyworkmate.companion.view'), 'terminal')
  assert.equal(entries.get('chat2api.companion.view'), 'terminal')
  assert.equal(entries.get('unrelated'), 'value')
})
