import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { localDirectory, openLocalDirectory } from '../../src/main/companion/folders.ts'
import { DEFAULT_COMPANION_SETTINGS, migrateCompanionName, renameCompanion, validateSettings } from '../../src/shared/companion.ts'

test('opening folders validates local directories and reports operating system failures', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dwm-folders-'))
  try {
    const directory = path.join(root, '中文 Folder & notes')
    await mkdir(directory)
    const file = path.join(root, 'file.txt'); await writeFile(file, 'text')
    assert.equal(await localDirectory(directory), directory)
    let opened = ''
    await openLocalDirectory(directory, async value => { opened = value; return '' })
    assert.equal(opened, directory)
    for (const value of [file, 'https://example.com', '.', '', 'C:\\bad\nfolder', directory + '\0', path.join(root, 'missing')]) {
      await assert.rejects(openLocalDirectory(value, async () => { throw new Error('Must not call the OS') }), error => !error.message.includes('Must not call the OS'))
    }
    await assert.rejects(openLocalDirectory(directory, async () => 'OS refused'), /OS refused/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('former assistant defaults migrate without replacing custom names or personas', () => {
  const legacy = { ...DEFAULT_COMPANION_SETTINGS, name: '小伴', persona: DEFAULT_COMPANION_SETTINGS.persona.replace(' DailyWorkMate', '小伴') }
  const migrated = migrateCompanionName(legacy)
  assert.equal(migrated.name, 'DailyWorkMate')
  assert.equal(migrated.persona, DEFAULT_COMPANION_SETTINGS.persona)
  assert.equal(legacy.name, '小伴')
  const custom = { ...legacy, name: '研究助手', persona: '用简明的中文回答' }
  assert.deepEqual(migrateCompanionName(custom), custom)
  const renamed = renameCompanion(DEFAULT_COMPANION_SETTINGS, '小章鱼')
  assert.match(renamed.persona, /你是 小章鱼/)
  assert.equal(renameCompanion(custom, 'DWM').persona, custom.persona)
  assert.equal(validateSettings({ ...DEFAULT_COMPANION_SETTINGS, name: '小伴' }).name, '小伴', 'explicit later choices stay editable')
})
