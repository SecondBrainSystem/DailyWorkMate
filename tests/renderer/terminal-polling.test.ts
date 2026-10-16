import test from 'node:test'
import assert from 'node:assert/strict'
import { pollWorkTerminal } from '../../src/renderer/src/lib/terminalPolling.ts'
import type { TerminalSnapshot } from '../../src/shared/companion.ts'

const initial: TerminalSnapshot = { id: 'existing-terminal', sessionId: 'existing-session', cursor: 12, data: '', error: '', reset: false, running: true }
const settled = () => new Promise<void>(resolve => setImmediate(resolve))

test('a temporary poll failure recovers the same terminal and output cursor without replacing its task', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const reads: Array<[string, number]> = []
  const output: string[] = []
  const errors: unknown[] = []
  const stop = pollWorkTerminal({ initial,
    poll: async (id, cursor) => {
      reads.push([id, cursor])
      if (reads.length === 1) throw new Error('Temporary IPC failure')
      return reads.length === 2 ? { ...initial, cursor: 18, data: 'during' } : { ...initial, cursor: 22, data: 'done', running: false }
    },
    accept: async next => { output.push(next.data) },
    onError: error => { errors.push(error) },
  })
  await settled()
  assert.equal(errors.length, 1)
  context.mock.timers.tick(1499); await settled()
  assert.equal(reads.length, 1, 'failed reads back off instead of repeatedly hammering IPC')
  context.mock.timers.tick(1); await settled()
  assert.deepEqual(reads, [[initial.id, 12], [initial.id, 12]], 'retry retains the cursor so output during disconnection is recovered')
  context.mock.timers.tick(80); await settled()
  assert.deepEqual(reads[2], [initial.id, 18])
  assert.deepEqual(output, ['during', 'done'])
  context.mock.timers.tick(10000); await settled()
  assert.equal(reads.length, 3, 'an authoritative exited snapshot stops polling')
  stop()
})

test('closing a view cancels queued recovery attempts', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let reads = 0
  const stop = pollWorkTerminal({ initial,
    poll: async () => { reads++; throw new Error('Lost connection') },
    accept: async () => { assert.fail('no successful read') }, onError: () => {},
  })
  await settled(); stop()
  context.mock.timers.tick(10000); await settled()
  assert.equal(reads, 1)
})

test('an explicitly removed terminal stops recovery and allows the view to offer a new connection', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let reads = 0
  let ended = false
  const stop = pollWorkTerminal({ initial,
    poll: async () => { reads++; throw new Error("Error invoking remote method 'companion:pollTerminal': Error: Terminal is no longer active") },
    accept: async () => { assert.fail('removed terminal cannot return output') },
    onError: (_error, terminalEnded) => { ended = terminalEnded },
  })
  await settled()
  assert.equal(ended, true)
  context.mock.timers.tick(10000); await settled()
  assert.equal(reads, 1)
  stop()
})

test('a response arriving after unmount cannot update the disposed terminal', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let complete!: (snapshot: TerminalSnapshot) => void
  let reads = 0
  const stop = pollWorkTerminal({ initial,
    poll: () => { reads++; return new Promise(resolve => { complete = resolve }) },
    accept: async () => { assert.fail('disposed view must not accept output') },
    onError: () => { assert.fail('disposed view must not report errors') },
  })
  stop(); complete({ ...initial, cursor: 13, data: 'x' }); await settled()
  context.mock.timers.tick(10000); await settled()
  assert.equal(reads, 1)
})

test('permission revocation stops the old reader without restarting its task', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let reads = 0
  let revoked = false
  const stop = pollWorkTerminal({ initial,
    poll: async () => { reads++; return { ...initial, running: false, accessChanged: true } },
    accept: async next => { revoked = !!next.accessChanged },
    onError: error => { throw error },
  })
  await settled()
  assert.equal(revoked, true)
  context.mock.timers.tick(10000); await settled()
  assert.equal(reads, 1)
  stop()
})

test('a lost startup response keeps polling the pending original terminal until it runs', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const pending = { ...initial, sessionId: '', cursor: 0, running: false, starting: true }
  const reads: string[] = []
  const states: TerminalSnapshot[] = []
  const stop = pollWorkTerminal({ initial: pending,
    poll: async id => {
      reads.push(id)
      return reads.length === 1 ? pending : { ...initial, starting: false }
    },
    accept: async next => { states.push(next) },
    onError: error => { throw error },
  })
  await settled()
  assert.equal(states[0].starting, true)
  context.mock.timers.tick(80); await settled()
  assert.equal(states[1].running, true)
  assert.deepEqual(reads, [initial.id, initial.id])
  stop()
})
