import test from 'node:test'
import assert from 'node:assert/strict'
import { describeProxyListenError, findExcludedPortRange } from '../../src/main/proxy/listenError.ts'

const endpoint = { host: '127.0.0.1', port: 11434 }
const denied = Object.assign(new Error('listen EACCES: permission denied 127.0.0.1:11434'), { code: 'EACCES' })

test('Windows exclusion rows are parsed independently of localized labels and optional managed markers', () => {
  const output = '协议 tcp 端口排除范围\r\n开始端口    结束端口\r\n---------    --------\r\n   11399    11498\r\n   18000    18009     *\r\n* 管理的端口排除。'
  assert.deepEqual(findExcludedPortRange(output, 11434), { start: 11399, end: 11498 })
  assert.deepEqual(findExcludedPortRange(output, 18009), { start: 18000, end: 18009 })
  assert.equal(findExcludedPortRange(output, 11499), undefined)
  assert.equal(findExcludedPortRange('0 65535\n1 70000\n12000 11000\n11000 12000 other text', 11434), undefined)
})

test('Windows EACCES reports the actual excluded range and preserves native error details', async () => {
  const families: number[] = []
  const message = await describeProxyListenError(denied, endpoint, {
    platform: 'win32', language: 'zh-CN',
    readExcludedRanges: async family => { families.push(family); return '11399 11498' },
  })
  assert.deepEqual(families, [4])
  assert.match(message, /Windows.*11399–11498/)
  assert.match(message, /没有程序监听/)
  assert.match(message, /其他|以外/)
  assert.ok(message.includes(denied.message))
})

test('IPv6 bind failures inspect IPv6 exclusions and format an unambiguous endpoint', async () => {
  const families: number[] = []
  const message = await describeProxyListenError(Object.assign(new Error('permission denied'), { code: 'EACCES', address: '::1' }), { host: 'localhost', port: 11434 }, {
    platform: 'win32',
    readExcludedRanges: async family => { families.push(family); return '11399 11498 *' },
  })
  assert.deepEqual(families, [6])
  assert.match(message, /excluded TCP port range 11399–11498/)
  const ipv6 = await describeProxyListenError(denied, { host: '::1', port: 11434 }, { platform: 'linux' })
  assert.match(ipv6, /\[::1\]:11434/)
})

test('diagnostic command failures retain actionable bind error and report the diagnostic failure', async () => {
  const failure = new Error('netsh timed out')
  const reported: unknown[] = []
  const message = await describeProxyListenError(denied, endpoint, {
    platform: 'win32',
    readExcludedRanges: async () => { throw failure },
    onDiagnosticFailure: error => reported.push(error),
  })
  assert.deepEqual(reported, [failure])
  assert.match(message, /exclusively held|reserved/)
  assert.ok(message.includes(denied.message))
  assert.doesNotMatch(message, /is in the Windows excluded/)
})

test('successful empty diagnostic results do not falsely identify an excluded range', async () => {
  const message = await describeProxyListenError(denied, endpoint, {
    platform: 'win32', readExcludedRanges: async () => 'Excluded port ranges\n12000 12099',
  })
  assert.match(message, /may be/)
  assert.doesNotMatch(message, /is in the Windows excluded/)
})

test('ordinary address conflicts and non-Windows errors do not invoke Windows diagnostics', async () => {
  const unexpectedQuery = async () => { assert.fail('Windows port diagnostic should not run') }
  const conflict = Object.assign(new Error('listen EADDRINUSE: address already in use'), { code: 'EADDRINUSE' })
  const busy = await describeProxyListenError(conflict, endpoint, { platform: 'win32', readExcludedRanges: unexpectedQuery })
  assert.match(busy, /already in use/)
  assert.ok(busy.includes(conflict.message))
  const permission = await describeProxyListenError(denied, endpoint, { platform: 'linux', readExcludedRanges: unexpectedQuery })
  assert.match(permission, /port permissions/)
  const other = await describeProxyListenError(new Error('address invalid'), endpoint, { platform: 'win32', readExcludedRanges: unexpectedQuery })
  assert.match(other, /Failed to listen on 127.0.0.1:11434: address invalid/)
})
