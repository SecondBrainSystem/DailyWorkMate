import test, { before, beforeEach, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import { mkdir, rm } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const output = path.resolve('tmp/qa/server-listeners-test.mjs')
let ProxyServer, setConfig, lifecycle, resetLifecycle, sessionManager, server

before(async () => {
  await mkdir(path.dirname(output), { recursive: true })
  await build({
    stdin: { contents: `
      export { ProxyServer } from './src/main/proxy/server.ts'
      export { setConfig } from './src/main/store/store'
      export { lifecycle, resetLifecycle, sessionManager } from './src/main/proxy/sessionManager'
    `, resolveDir: process.cwd() },
    outfile: output, bundle: true, format: 'esm', platform: 'node', packages: 'external',
    plugins: [{ name: 'isolate-listener-tests', setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'qa' }))
      builder.onResolve({ filter: /(?:\/store\/store$|^\.\/routes(?:\/management)?$|(?:^\.\/|\/proxy\/)sessionManager$)/ }, args => ({
        path: args.path.includes('/store/') ? 'store' : args.path.includes('routes') ? 'routes' : 'sessions', namespace: 'qa',
      }))
      builder.onLoad({ filter: /.*/, namespace: 'qa' }, args => ({ contents:
        args.path === 'electron' ? 'export const app = { getVersion: () => "test" }; export const BrowserWindow = { getAllWindows: () => [] }'
        : args.path === 'store' ? `
          let config = {}
          export const setConfig = value => { config = value }
          export const storeManager = { getConfig: () => config, addLog: () => {} }
        ` : args.path === 'sessions' ? `
          let state = { initialized: 0, destroyed: 0, live: false }
          export const lifecycle = () => ({ ...state })
          export const resetLifecycle = () => { state = { initialized: 0, destroyed: 0, live: false } }
          export const sessionManager = {
            initialize: () => { state = { ...state, initialized: state.initialized + 1, live: true } },
            destroy: () => { state = { ...state, destroyed: state.destroyed + 1, live: false } },
          }
        ` : `
          import { PassThrough } from 'node:stream'
          export default [{
            routes: () => async (ctx, next) => {
              if (ctx.path !== '/stream') return next()
              const stream = new PassThrough()
              ctx.type = 'text/event-stream'
              ctx.body = stream
              stream.write('data: ready\\n\\n')
              const timer = setInterval(() => stream.write('data: heartbeat\\n\\n'), 20)
              stream.once('close', () => clearInterval(timer))
            },
            allowedMethods: () => async (ctx, next) => next(),
          }]
        `,
      }))
    } }],
  })
  ;({ ProxyServer, setConfig, lifecycle, resetLifecycle, sessionManager } = await import(pathToFileURL(output).href))
})

beforeEach(() => {
  resetLifecycle()
  // The app owns sessions so internal inference remains usable with zero public listeners.
  sessionManager.initialize()
  setConfig({ proxyPort: 32123, proxyHost: '127.0.0.1', enableApiKey: false, apiKeys: [], requestTimeout: 120000, retryCount: 3 })
  server = new ProxyServer()
})
afterEach(async () => { await server.stop() })
after(async () => { await rm(output, { force: true }) })

async function reservePort() {
  const reservation = http.createServer()
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve) })
  return { server: reservation, port: reservation.address().port }
}

async function freePorts(count) {
  const reservations = await Promise.all(Array.from({ length: count }, reservePort))
  await Promise.all(reservations.map(({ server }) => new Promise(resolve => server.close(resolve))))
  return reservations.map(({ port }) => port)
}

async function health(port) {
  const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).status, 'running')
}

async function openStream(port) {
  const controller = new AbortController()
  const response = await fetch(`http://127.0.0.1:${port}/stream`, { signal: controller.signal })
  assert.equal(response.status, 200)
  const reader = response.body.getReader()
  assert.equal((await reader.read()).done, false)
  return { controller, reader }
}

test('starts configured and additional ports with idempotence and one shared session lifecycle', async () => {
  const [first, second] = await freePorts(2)
  setConfig({ proxyPort: first, proxyHost: '127.0.0.1', enableApiKey: false, apiKeys: [] })
  assert.equal(await server.start(), true)
  const startedAt = server.getStatus().startTime
  assert.equal(await server.start(second), true)
  assert.equal(await server.start(second, '127.0.0.1'), true)
  assert.equal(server.getPort(), first)
  assert.equal(server.getHost(), '127.0.0.1')
  assert.equal(server.getStatus().startTime, startedAt)
  assert.deepEqual(server.getStatus().listeners.map(listener => listener.port), [first, second])
  assert.deepEqual(lifecycle(), { initialized: 1, destroyed: 0, live: true })
  await Promise.all([health(first), health(second)])
  assert.ok(server.getStatus().listeners.every(listener => listener.connections >= 1 && listener.uptime >= 0))
})

test('stopping one listener preserves the other listener, streaming response, and sessions', async () => {
  const [first, second] = await freePorts(2)
  await server.start(first)
  await server.start(second)
  const { controller, reader } = await openStream(second)
  try {
    assert.equal(await server.stop(first), true)
    assert.equal(server.getPort(), second)
    assert.equal(server.isRunning(), true)
    assert.deepEqual(lifecycle(), { initialized: 1, destroyed: 0, live: true })
    assert.equal((await reader.read()).done, false)
    await health(second)
  } finally { controller.abort(); await reader.cancel().catch(() => {}) }
  assert.equal(await server.stop(second), true)
  assert.equal(server.isRunning(), false)
  assert.deepEqual(server.getStatus().listeners, [])
  assert.deepEqual(lifecycle(), { initialized: 1, destroyed: 0, live: true })
})

test('busy ports fail with details without changing a healthy listener or shared state', async () => {
  const [first] = await freePorts(1)
  const occupied = await reservePort()
  try {
    await server.start(first)
    assert.equal(await server.start(occupied.port), false)
    assert.match(server.getLastError(), /already in use/)
    assert.match(server.getLastError(), new RegExp(String(occupied.port)))
    assert.equal(server.getPort(), first)
    await health(first)
    assert.equal(await server.restart(occupied.port), false)
    await health(first)
    assert.deepEqual(lifecycle(), { initialized: 1, destroyed: 0, live: true })
    assert.deepEqual(server.getStatus().listeners.map(listener => listener.port), [first])
  } finally { await new Promise(resolve => occupied.server.close(resolve)) }
})

test('permission-denied binds preserve the active listener and allow a later start', async t => {
  const [first, deniedPort, available] = await freePorts(3)
  await server.start(first)
  const originalListen = http.Server.prototype.listen
  t.mock.method(http.Server.prototype, 'listen', function (...args) {
    if (args[0] !== deniedPort) return originalListen.apply(this, args)
    process.nextTick(() => this.emit('error', Object.assign(new Error(`listen EACCES: permission denied 127.0.0.1:${deniedPort}`), {
      code: 'EACCES', address: '127.0.0.1', port: deniedPort,
    })))
    return this
  })
  assert.equal(await server.start(deniedPort), false)
  assert.match(server.getLastError(), /EACCES/)
  assert.match(server.getLastError(), new RegExp(String(deniedPort)))
  assert.deepEqual(server.getStatus().listeners.map(listener => listener.port), [first])
  assert.deepEqual(lifecycle(), { initialized: 1, destroyed: 0, live: true })
  await health(first)
  assert.equal(await server.start(available), true)
  assert.equal(server.getLastError(), undefined)
  await Promise.all([health(first), health(available)])
})

test('overlapping starts and stops are serialized without duplicate listeners or dangling services', async () => {
  const [first, second, third] = await freePorts(3)
  assert.deepEqual(await Promise.all([server.start(first), server.start(first), server.start(second)]), [true, true, true])
  assert.equal(server.getStatus().listeners.length, 2)
  assert.deepEqual(await Promise.all([server.start(third), server.stop(third)]), [true, true])
  assert.deepEqual(server.getStatus().listeners.map(listener => listener.port), [first, second])
  assert.deepEqual(await Promise.all([server.stop(first), server.start(first)]), [true, true])
  await Promise.all([health(first), health(second)])
  assert.deepEqual(lifecycle(), { initialized: 1, destroyed: 0, live: true })
  assert.deepEqual(await Promise.all([server.stop(), server.start(third)]), [true, true])
  assert.deepEqual(server.getStatus().listeners.map(listener => listener.port), [third])
  assert.deepEqual(lifecycle(), { initialized: 1, destroyed: 0, live: true })
  await health(third)
})

test('restarting or moving the primary keeps unrelated streams running', async () => {
  const [first, second, third] = await freePorts(3)
  await server.start(first)
  await server.start(second)
  const { controller, reader } = await openStream(second)
  try {
    assert.equal(await server.restart(), true)
    assert.equal(server.getPort(), first)
    await Promise.all([health(first), health(second)])
    assert.equal((await reader.read()).done, false)
    assert.equal(await server.restart(third), true)
    assert.equal(server.getPort(), third)
    assert.deepEqual(server.getStatus().listeners.map(listener => listener.port).sort(), [second, third].sort())
    await Promise.all([health(second), health(third)])
    assert.equal((await reader.read()).done, false)
    assert.deepEqual(lifecycle(), { initialized: 1, destroyed: 0, live: true })
  } finally { controller.abort(); await reader.cancel().catch(() => {}) }
})

test('invalid endpoints and unauthenticated network binds cannot disturb an existing endpoint', async () => {
  const [first, second] = await freePorts(2)
  await server.start(first)
  for (const port of [0, -1, 1.5, 65536, NaN, null, '11434']) {
    assert.equal(await server.start(port), false)
    assert.match(server.getLastError(), /integer between/)
  }
  for (const host of ['', 'http://127.0.0.1', '127.0.0.1:11434', '../socket', null]) {
    assert.equal(await server.start(second, host), false)
    assert.match(server.getLastError(), /host must/)
  }
  assert.equal(await server.start(second, '0.0.0.0'), false)
  assert.match(server.getLastError(), /API key authentication/)
  await health(first)
  assert.deepEqual(lifecycle(), { initialized: 1, destroyed: 0, live: true })
})

test('changing the primary bind address on the same port preserves other endpoints', async () => {
  const [first, second] = await freePorts(2)
  setConfig({ proxyHost: '127.0.0.1', enableApiKey: true, apiKeys: [{ key: 'test-key', enabled: true }] })
  await server.start(first)
  await server.start(second)
  assert.equal(await server.restart(first, '0.0.0.0'), true)
  assert.equal(server.getHost(), '0.0.0.0')
  await Promise.all([health(first), health(second)])
  assert.deepEqual(lifecycle(), { initialized: 1, destroyed: 0, live: true })
})

test('a failed initial public bind preserves app sessions and permits a subsequent start', async () => {
  const occupied = await reservePort()
  const [available] = await freePorts(1)
  try {
    assert.equal(await server.start(occupied.port), false)
    assert.equal(server.isRunning(), false)
    assert.deepEqual(lifecycle(), { initialized: 1, destroyed: 0, live: true })
    assert.equal(await server.start(available), true)
    assert.equal(server.getLastError(), undefined)
    await health(available)
    assert.deepEqual(lifecycle(), { initialized: 1, destroyed: 0, live: true })
  } finally { await new Promise(resolve => occupied.server.close(resolve)) }
})
