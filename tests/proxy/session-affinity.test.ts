import test from 'node:test'
import assert from 'node:assert/strict'
import { SessionAffinity, openCodeAffinityKey } from '../../src/main/proxy/sessionAffinity.ts'

test('native OpenCode routing hints are bounded and scoped by session and model', () => {
  const key = openCodeAffinityKey({ 'x-opencode-session-id': 'ses_abc123' }, 'gemma')
  assert.ok(key)
  assert.notEqual(key, openCodeAffinityKey({ 'x-opencode-session-id': 'ses_other' }, 'gemma'))
  assert.notEqual(key, openCodeAffinityKey({ 'x-opencode-session-id': 'ses_abc123' }, 'minimax'))
  for (const value of [undefined, ['ses_abc'], 'ses_', 'other', 'ses_a\n', 'ses_' + 'x'.repeat(161)]) {
    assert.equal(openCodeAffinityKey({ 'x-opencode-session-id': value }, 'gemma'), undefined)
  }
})

test('routing bindings expire and bound memory without losing a recently successful session', () => {
  let clock = 0
  const cache = new SessionAffinity(2, 100, () => clock)
  cache.remember('a', 'one'); cache.remember('b', 'two')
  clock = 10
  cache.remember('a', 'one'); cache.remember('c', 'three')
  assert.equal(cache.get('a'), 'one')
  assert.equal(cache.get('b'), undefined)
  assert.equal(cache.get('c'), 'three')
  clock = 110
  assert.equal(cache.get('a'), undefined)
})

test('an older failed request cannot erase a newer successful failover binding', () => {
  const cache = new SessionAffinity()
  cache.remember('session', 'old')
  cache.remember('session', 'new')
  cache.forget('session', 'old')
  assert.equal(cache.get('session'), 'new')
  cache.forget('session', 'new')
  assert.equal(cache.get('session'), undefined)
  cache.remember(undefined, 'ignored')
  assert.equal(cache.get(undefined), undefined)
})
