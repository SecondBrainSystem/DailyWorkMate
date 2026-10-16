import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getProxyListeners, listenerKey, listenerUrl,
  validateListenerHost, validateListenerPort,
} from '../../src/renderer/src/components/proxy/listener-utils.ts'

const primary = { host: '127.0.0.1', port: 32123 }
const secondary = { host: '127.0.0.1', port: 11434 }

test('a running additional listener does not make a stopped primary appear running', () => {
  const listeners = getProxyListeners(primary, [secondary], {
    ...primary, isRunning: true, listeners: [{ ...secondary, isRunning: true }],
  })
  assert.equal(listeners[0].isRunning, false)
  assert.equal(listeners[1].isRunning, true)
  assert.equal(listeners[1].saved, true)
})

test('configured endpoints remain after stop and temporary running endpoints remain controllable', () => {
  const temporary = { host: '::1', port: 11435 }
  const listeners = getProxyListeners(primary, [secondary], {
    ...primary, isRunning: true, listeners: [{ ...temporary, isRunning: true }],
  })
  assert.deepEqual(listeners.map(({ port, isRunning, saved }) => ({ port, isRunning, saved })), [
    { port: 32123, isRunning: false, saved: false },
    { port: 11434, isRunning: false, saved: true },
    { port: 11435, isRunning: true, saved: false },
  ])
  assert.equal(getProxyListeners(primary, [], { ...primary, isRunning: true, listeners: [] })[0].isRunning, false)
  assert.equal(getProxyListeners(primary, [], { ...primary, isRunning: true })[0].isRunning, true)
})

test('bracketed IPv6 addresses deduplicate and format a valid client URL', () => {
  const ipv6 = { host: '::1', port: 32123 }
  const listeners = getProxyListeners(ipv6, [{ ...ipv6, host: '[::1]' }], {
    ...ipv6, isRunning: true, listeners: [{ ...ipv6, host: ' [::1] ', isRunning: true }],
  })
  assert.equal(listeners.length, 1)
  assert.equal(listeners[0].isRunning, true)
  assert.equal(listenerUrl(ipv6), 'http://[::1]:32123/v1')
  assert.equal(listenerKey({ host: ' LOCALHOST ', port: 32123 }), 'localhost:32123')
})

test('listener input rejects fractional ports, invalid addresses and URLs', () => {
  for (const value of ['0', '65536', '11434.5', '11434x', '1e3', '', '-1', 'NaN']) {
    assert.ok(validateListenerPort(value), `invalid port ${value}`)
  }
  for (const value of ['1', '80', '1023', '11434', '65535']) assert.equal(validateListenerPort(value), undefined)
  for (const value of ['', '999.0.0.1', '127.0.0', 'http://localhost', 'a/b', '::::', '[broken]', '-host', 'space host']) {
    assert.ok(validateListenerHost(value), `invalid host ${value}`)
  }
  for (const value of ['127.0.0.1', '0.0.0.0', '::', '::1', '[::1]', 'localhost', 'api.example.test']) {
    assert.equal(validateListenerHost(value), undefined, `valid host ${value}`)
  }
})
