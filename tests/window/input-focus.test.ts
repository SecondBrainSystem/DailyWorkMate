import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { registerWindowInputFocus } from '../../src/main/window/inputFocus.ts'

function fixture() {
  let state = { visible: true, active: true, enabled: true, destroyed: false, pageDestroyed: false, pageFocused: false, devTools: false }
  let calls = 0
  const webContents = Object.assign(new EventEmitter(), {
    isDestroyed: () => state.pageDestroyed, isFocused: () => state.pageFocused, isDevToolsFocused: () => state.devTools,
    focus: () => { calls++; state = { ...state, pageFocused: true } },
  })
  const window = Object.assign(new EventEmitter(), {
    webContents, isDestroyed: () => state.destroyed, isVisible: () => state.visible,
    isFocused: () => state.active, isEnabled: () => state.enabled,
  })
  registerWindowInputFocus(window as unknown as Parameters<typeof registerWindowInputFocus>[0])
  return { window, webContents, calls: () => calls, set: (patch: Partial<typeof state>) => { state = { ...state, ...patch } } }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

test('initial show, late page load and returning from a native dialog restore page input focus', async () => {
  const f = fixture()
  f.window.emit('show'); f.window.emit('focus')
  assert.equal(f.calls(), 0, 'wait for native activation to settle')
  await tick()
  assert.equal(f.calls(), 1)
  f.set({ pageFocused: false }); f.webContents.emit('did-finish-load'); await tick()
  assert.equal(f.calls(), 2)
  f.set({ enabled: false, pageFocused: false }); f.window.emit('focus'); await tick()
  assert.equal(f.calls(), 2, 'a native modal still owns input')
  f.set({ enabled: true }); f.window.emit('focus'); await tick()
  assert.equal(f.calls(), 3, 'input recovers without choosing a workspace')
})

test('focus recovery respects other applications, hidden windows, DevTools and destruction', async () => {
  for (const patch of [{ active: false }, { visible: false }, { enabled: false }, { destroyed: true }, { pageDestroyed: true }, { devTools: true }, { pageFocused: true }]) {
    const f = fixture()
    f.window.emit('focus'); f.set(patch); await tick()
    assert.equal(f.calls(), 0, JSON.stringify(patch))
  }
  const f = fixture()
  f.window.emit('focus'); f.window.emit('closed'); await tick()
  assert.equal(f.calls(), 0)
})
