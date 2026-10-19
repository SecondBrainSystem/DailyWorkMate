import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RequestLogManager } from '../../src/main/requestLogs/manager.ts'

test('steady traffic still reaches disk: persistence is throttled, not postponed by every new entry', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'request-log-throttle-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const manager = new RequestLogManager({ storageDir: root, config: { enabled: true, maxEntries: 100, includeBodies: false, maxBodyChars: 0, redactSensitiveData: true } })
  await manager.initialize()
  const file = join(root, 'request-logs.ndjson')
  const entry = (index: number) => ({
    timestamp: Date.now(), status: 'success' as const, statusCode: 200, method: 'POST', url: '/v1/chat/completions',
    model: `model-${index}`, responseStatus: 200, latency: 1, isStream: false,
  })
  // One request every second: a debounce of 2s would never fire.
  for (let index = 0; index < 3; index++) {
    manager.addRequestLog(entry(index))
    t.mock.timers.tick(1000)
  }
  assert.ok(existsSync(file), 'written within the throttle window despite continuous traffic')
  assert.match(readFileSync(file, 'utf-8'), /model-1/)
  manager.addRequestLog(entry(9))
  manager.flushSync()
  assert.match(readFileSync(file, 'utf-8'), /model-9/, 'the quit flush writes what is still pending')
})

test('live view listeners get one body-free notification per entry per 250ms with its latest state', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'request-log-notify-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const manager = new RequestLogManager({ storageDir: root, config: { enabled: true, maxEntries: 100, includeBodies: true, maxBodyChars: 1000, redactSensitiveData: true } })
  await manager.initialize()
  const seen: { id: string; status: string; requestBody?: string }[] = []
  const unsubscribe = manager.onLogChanged(entry => seen.push(entry))
  const log = manager.addRequestLog({ timestamp: Date.now(), status: 'success', statusCode: 200, method: 'POST', url: '/v1/chat/completions', model: 'm', responseStatus: 200, latency: 1, isStream: true, requestBody: '{"a":1}' })
  manager.updateRequestLog(log.id, { status: 'error' })
  assert.equal(seen.length, 0)
  t.mock.timers.tick(250)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].status, 'error')
  assert.equal(seen[0].requestBody, undefined)
  unsubscribe()
  manager.updateRequestLog(log.id, { status: 'success' })
  t.mock.timers.tick(250)
  assert.equal(seen.length, 1)
})
