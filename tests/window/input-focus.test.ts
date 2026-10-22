import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { registerWindowInputFocus, withWindowInputFocus } from '../../src/main/window/inputFocus.ts'

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
    f.window.emit('closed')
  }
  const f = fixture()
  f.window.emit('focus'); f.window.emit('closed'); await tick()
  assert.equal(f.calls(), 0)
})

test('native teardown may re-enable the window without sending another focus event', async () => {
  const f = fixture()
  f.set({ enabled: false })
  f.window.emit('focus')
  await tick()
  assert.equal(f.calls(), 0)
  f.set({ enabled: true })
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(f.calls(), 1)
  f.window.emit('closed')
})

test('picker selection, cancellation and errors restore focus even without an activation event', async () => {
  for (const outcome of ['selected', 'cancelled', 'error']) {
    const f = fixture()
    const operation = withWindowInputFocus(f.window as unknown as Parameters<typeof withWindowInputFocus>[0], async () => {
      if (outcome === 'error') throw new Error('Picker failed')
      return outcome
    })
    if (outcome === 'error') await assert.rejects(operation, /Picker failed/)
    else assert.equal(await operation, outcome)
    await tick()
    assert.equal(f.calls(), 1, outcome)
    f.window.emit('closed')
  }
})

test('a delayed retry neither steals focus nor runs after the window closes', async () => {
  for (const close of [true, false]) {
    const f = fixture()
    f.set({ enabled: false })
    f.window.emit('focus')
    await tick()
    if (close) f.window.emit('closed')
    else f.set({ active: false })
    f.set({ enabled: true })
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.equal(f.calls(), 0)
    if (!close) f.window.emit('closed')
  }
})
