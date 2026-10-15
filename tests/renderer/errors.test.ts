import test from 'node:test'
import assert from 'node:assert/strict'
import { errorMessage, errorText, localizeBilingual } from '../../src/renderer/src/lib/errors.ts'

test('IPC wrappers and Error prefixes are removed', () => {
  assert.equal(errorMessage(new Error("Error invoking remote method 'companion:get': Error: Saved avatar is missing")), 'Saved avatar is missing')
  assert.equal(errorMessage('TypeError: Failed to fetch'), 'Failed to fetch')
  assert.equal(errorMessage({ message: 'plain object' }), 'plain object')
  assert.equal(errorMessage(undefined), '')
})

test('bilingual main-process messages show the half matching the UI language', () => {
  const message = 'OpenCode 正在更新，请稍后再试。 / OpenCode is updating; try again shortly.'
  assert.equal(localizeBilingual(message, true), 'OpenCode 正在更新，请稍后再试。')
  assert.equal(localizeBilingual(message, false), 'OpenCode is updating; try again shortly.')
  // A path or ratio containing " / " is not a language split.
  assert.equal(localizeBilingual('Project / docs', false), 'Project / docs')
  assert.equal(localizeBilingual('项目 / 文档', true), '项目 / 文档')
  // The split is found even when the Chinese half itself contains " / ".
  assert.equal(localizeBilingual('分组 A / B 不存在。 / Group A / B does not exist.', false), 'Group A / B does not exist.')
  assert.equal(errorText(new Error("Error invoking remote method 'x': Error: 最多同时打开 8 个工作标签。 / At most 8 work tabs can be open at once."), false), 'At most 8 work tabs can be open at once.')
  assert.equal(errorText('', true, '操作失败'), '操作失败')
})
