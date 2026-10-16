import test from 'node:test'
import assert from 'node:assert/strict'
import { isProxyEndpointRunning, parseProxyListeners } from '../../src/shared/proxyListeners.ts'
import { configurationBackup, readConfigurationBackup } from '../../src/shared/configBackup.ts'
import type { AppConfig, ProxyStatus } from '../../src/shared/types.ts'

test('clients distinguish their configured endpoint from other running services', () => {
  const primary = { port: 32123, host: '127.0.0.1' }
  const secondary = { port: 11434, host: '127.0.0.1' }
  const status: ProxyStatus = { ...secondary, isRunning: true, uptime: 1, connections: 0, listeners: [{ ...secondary, isRunning: true, uptime: 1, connections: 0 }] }
  assert.equal(isProxyEndpointRunning(status, primary), false)
  assert.equal(isProxyEndpointRunning(status, secondary), true)
  assert.equal(isProxyEndpointRunning({ ...status, listeners: [] }, secondary), false)
  assert.equal(isProxyEndpointRunning({ ...status, listeners: undefined }, secondary), true)
  assert.equal(isProxyEndpointRunning(null, primary), false)
  assert.equal(isProxyEndpointRunning({ ...status, host: '::1', listeners: undefined }, { port: 11434, host: '[::1]' }), true)
})

test('saved service endpoints are copied, normalized and retained by configuration backups', () => {
  const input = Object.freeze([Object.freeze({ port: 11434, host: '127.0.0.1' }), Object.freeze({ port: 32124, host: '[::1]' })])
  const listeners = parseProxyListeners(input)
  assert.deepEqual(listeners, [{ port: 11434, host: '127.0.0.1' }, { port: 32124, host: '::1' }])
  assert.notEqual(listeners[0], input[0])
  assert.equal(input[1].host, '[::1]')
  const config = { proxyPort: 32123, proxyHost: '127.0.0.1', additionalProxyListeners: listeners, internalProxyKey: 'private' } as AppConfig
  const backup = configurationBackup(config)
  assert.deepEqual(readConfigurationBackup({ config: backup }).additionalProxyListeners, listeners)
  assert.equal(backup.internalProxyKey, undefined)
})

test('invalid service configuration cannot persist invalid ports, duplicate endpoints or unbounded lists', () => {
  for (const value of [null, {}, [{ port: '11434', host: 'localhost' }], [{ port: 0, host: 'localhost' }], [{ port: 1.5, host: 'localhost' }], [{ port: 65536, host: 'localhost' }], [{ port: 11434, host: '' }], [{ port: 11434, host: 'http://localhost' }], [{ port: 11434, host: 'localhost/path' }], Array.from({ length: 33 }, (_, index) => ({ port: index + 1, host: 'localhost' }))]) {
    assert.throws(() => parseProxyListeners(value))
  }
  assert.throws(() => parseProxyListeners([{ port: 11434, host: 'LOCALHOST' }, { port: 11434, host: 'localhost' }]), /Duplicate/)
  assert.throws(() => parseProxyListeners([{ port: 11434, host: '[::1]' }, { port: 11434, host: '::1' }]), /Duplicate/)
  for (const host of ['localhost:1234', '[]', '::::', '..', '300.0.0.1', '127.1', '-invalid.local']) {
    assert.throws(() => parseProxyListeners([{ port: 11434, host }]), /host/)
  }
  assert.deepEqual(parseProxyListeners([]), [])
})
