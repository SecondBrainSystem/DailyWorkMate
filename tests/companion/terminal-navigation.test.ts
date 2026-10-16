import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldCloseWorkTerminalsForNavigation } from '../../src/main/companion/terminalLifecycle.ts'

test('switching HashRouter pages keeps Work processes while full document replacement closes them', () => {
  assert.equal(shouldCloseWorkTerminalsForNavigation(true, true), false)
  assert.equal(shouldCloseWorkTerminalsForNavigation(false, false), false)
  assert.equal(shouldCloseWorkTerminalsForNavigation(true, false), false)
  assert.equal(shouldCloseWorkTerminalsForNavigation(false, true), true)
})
