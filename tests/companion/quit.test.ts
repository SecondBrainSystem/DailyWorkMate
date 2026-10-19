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

test('declining keeps every service running and only a confirmed quit is marked as quitting', async () => {
  let accept = false, cleaned = 0, committed = 0, cancellations = 0, begun = 0
  const quit = createQuitController({ confirm: async () => { assert.equal(begun, 0, 'quitting is not announced while the user decides'); return accept },
    begin: () => { begun++ }, cleanup: async () => { cleaned++ }, commit: () => { committed++ }, cancel: () => { cancellations++ } })
  const event = { preventDefault: () => {} }
  quit(event); await tick()
  assert.equal(cleaned, 0); assert.equal(begun, 0); assert.equal(cancellations, 1)
  accept = true; quit(event); await tick()
  assert.equal(begun, 1); assert.equal(cleaned, 1); assert.equal(committed, 1)
})

test('cleanup failure is reported but the confirmed quit still finishes', async () => {
  const failures: unknown[] = []
  let committed = 0, cancelled = 0
  const quit = createQuitController({ confirm: async () => true, cleanup: async () => { throw new Error('still running') },
    cleanupFailed: error => { failures.push(error) }, commit: () => { committed++ }, cancel: () => { cancelled++ } })
  quit({ preventDefault: () => {} }); await tick()
  assert.equal(committed, 1); assert.equal(cancelled, 0)
  assert.match(String(failures[0]), /still running/)
})

test('a confirmation error cancels before cleanup', async () => {
  let cleaned = 0
  const errors: unknown[] = []
  const quit = createQuitController({ confirm: async () => { throw new Error('dialog failed') }, cleanup: async () => { cleaned++ }, commit: () => assert.fail('unexpected commit'), cancel: error => { errors.push(error) } })
  quit({ preventDefault: () => {} }); await tick()
  assert.equal(cleaned, 0); assert.match(String(errors[0]), /dialog failed/)
})

test('a committed quit that is blocked elsewhere ends the process instead of staying open without services', async () => {
  let exits = 0, prevented = 0
  const quit = createQuitController({ confirm: async () => true, cleanup: async () => {}, commit: () => {}, cancel: () => assert.fail('unexpected cancellation'), exit: () => { exits++ }, exitDelay: 5 })
  quit({ preventDefault: () => { prevented++ } }); await tick()
  quit({ preventDefault: () => { prevented++ } })
  assert.equal(prevented, 1, 'after commit the quit is no longer intercepted')
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(exits, 1)
})
