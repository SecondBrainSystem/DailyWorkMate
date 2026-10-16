import test from 'node:test'
import assert from 'node:assert/strict'
import { createQuitController } from '../../src/main/quit.ts'

const tick = () => new Promise(resolve => setImmediate(resolve))
test('repeated quit requests wait for cleanup and commit once', async () => {
  let done!: () => void, confirmations = 0, cleanups = 0, commits = 0, prevented = 0
  const pending = new Promise<void>(resolve => { done = resolve })
  const quit = createQuitController({ confirm: async () => { confirmations++; return true }, cleanup: async () => { cleanups++; await pending }, commit: () => { commits++ }, cancel: () => assert.fail('unexpected cancellation') })
  const event = { preventDefault: () => { prevented++ } }
  quit(event); quit(event); await tick()
  assert.equal(commits, 0); assert.equal(cleanups, 1); assert.equal(confirmations, 1)
  done(); await tick(); assert.equal(commits, 1)
  quit(event); assert.equal(prevented, 2)
})

test('cancel leaves processes intact and cleanup failure permits a later retry', async () => {
  let accept = false, fail = true, cleaned = 0, committed = 0, cancellations = 0
  const quit = createQuitController({ confirm: async () => accept, cleanup: async () => { cleaned++; if (fail) throw new Error('still running') }, commit: () => { committed++ }, cancel: () => { cancellations++ } })
  const event = { preventDefault: () => {} }
  quit(event); await tick(); assert.equal(cleaned, 0)
  accept = true; quit(event); await tick(); assert.equal(committed, 0); assert.equal(cancellations, 2)
  fail = false; quit(event); await tick(); assert.equal(committed, 1); assert.equal(cleaned, 2)
})
