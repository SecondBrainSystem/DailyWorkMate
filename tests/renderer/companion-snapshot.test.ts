import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_COMPANION_SETTINGS, type CompanionSnapshot } from '../../src/shared/companion.ts'
import { mergeCompanionSnapshot } from '../../src/renderer/src/lib/companionSnapshot.ts'

const original: CompanionSnapshot = {
  settings: { ...DEFAULT_COMPANION_SETTINGS, avatar: 'avatar.png', avatarMode: '3d', avatarModel: 'custom.glb' },
  avatarUrl: 'data:image/png;base64,custom', avatarModelUrl: 'data:model/gltf-binary;base64,custom',
  avatarModelError: 'Saved model warning', home: 'qa', workspaces: [], groups: [], messages: [], runtimeAvailable: true,
}

test('speech and other setting saves preserve both avatar assets and their error state', () => {
  const saved = { ...original, settings: { ...original.settings, speechEnabled: false, speechRate: 1.2 }, assetsIncluded: false, avatarUrl: '', avatarModelUrl: '', avatarModelError: undefined }
  const merged = mergeCompanionSnapshot(original, saved)
  assert.equal(merged.settings.speechEnabled, false)
  assert.equal(merged.settings.speechRate, 1.2)
  assert.equal(merged.avatarUrl, original.avatarUrl)
  assert.equal(merged.avatarModelUrl, original.avatarModelUrl)
  assert.equal(merged.avatarModelError, original.avatarModelError)
  assert.equal(original.settings.speechEnabled, true)
  assert.equal(saved.avatarModelUrl, '')
})

test('full avatar imports and explicit resets replace assets and clear old warnings', () => {
  for (const avatarUrl of ['', 'data:image/png;base64,replacement']) {
    const result = { ...original, assetsIncluded: true, avatarUrl, avatarModelUrl: '', avatarModelError: undefined }
    const merged = mergeCompanionSnapshot(original, result)
    assert.equal(merged.avatarUrl, avatarUrl)
    assert.equal(merged.avatarModelUrl, '')
    assert.equal(merged.avatarModelError, undefined)
  }
})
