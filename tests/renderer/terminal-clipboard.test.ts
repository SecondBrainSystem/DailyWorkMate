import test from 'node:test'
import assert from 'node:assert/strict'
import { copiesTerminalSelection } from '../../src/renderer/src/lib/terminalClipboard.ts'

test('copy shortcuts consume Ctrl+C only when the terminal has a selection', () => {
  const key = { key: 'c', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, isComposing: false }
  assert.equal(copiesTerminalSelection(key, true), true)
  assert.equal(copiesTerminalSelection(key, false), false, 'Ctrl+C still interrupts')
  assert.equal(copiesTerminalSelection({ ...key, key: 'C', shiftKey: true }, true), true)
  assert.equal(copiesTerminalSelection({ ...key, ctrlKey: false, metaKey: true }, true), true)
  assert.equal(copiesTerminalSelection({ ...key, altKey: true }, true), false)
  assert.equal(copiesTerminalSelection({ ...key, isComposing: true }, true), false)
  assert.equal(copiesTerminalSelection({ ...key, key: 'v' }, true), false, 'pasting stays with xterm')
})
