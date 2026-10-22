import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import { mkdir, rm } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const output = path.resolve('tmp/qa/server-auth-test.mjs')
let server, endpoint, setConfig, getConfig, internalProxyKey
before(async () => {
  await mkdir(path.dirname(output), { recursive: true })
  await build({
    stdin: { contents: `export { ProxyServer } from './src/main/proxy/server.ts'; export { internalProxyKey } from './src/main/proxy/internalAuth.ts'; export { setConfig, getConfig } from './src/main/store/store'`, resolveDir: process.cwd() },
    outfile: output, bundle: true, format: 'esm', platform: 'node', packages: 'external',
    plugins: [{ name: 'isolate-server-tests', setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'qa' }))
      builder.onResolve({ filter: /(?:\/store\/store$|^\.\/routes(?:\/management)?$|^\.\/sessionManager$)/ }, args => ({
        path: args.path.includes('/store/') ? 'store' : args.path.includes('routes') ? 'routes' : 'sessions', namespace: 'qa',
      }))
      builder.onLoad({ filter: /.*/, namespace: 'qa' }, args => ({ contents:
        args.path === 'electron' ? 'export const app = { getVersion: () => "test" }; export const BrowserWindow = { getAllWindows: () => [] }' : args.path === 'store'
          ? `let config = { enableApiKey: true, apiKeys: [] }; export const setConfig = value => { config = value }; export const getConfig = () => config; export const storeManager = { getConfig, recordApiKeyUsage: id => { config = { ...config, apiKeys: config.apiKeys.map(key => key.id === id ? { ...key, usageCount: key.usageCount + 1 } : key) } }, updateConfig: value => { config = {...config, ...value} }, addLog: () => {} }`
          : args.path === 'routes' ? 'export default []' : 'export const sessionManager = {}',
      }))
    } }],
  })
  const module = await import(pathToFileURL(output).href)
  ;({ setConfig, getConfig, internalProxyKey } = module)
  // Exercise the real Koa middleware while keeping storage and provider routes isolated.
  server = http.createServer(new module.ProxyServer().app.callback())
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  endpoint = `http://127.0.0.1:${server.address().port}`
})
after(async () => {
  server?.closeAllConnections()
  if (server) await new Promise(resolve => server.close(resolve))
  await rm(output, { force: true })
})

test('enabled authentication rejects requests even when no API keys exist', async () => {
  setConfig({ enableApiKey: true, apiKeys: [] })
  for (const headers of [{}, { Authorization: 'Bearer unknown' }]) {
    const response = await fetch(`${endpoint}/v1/chat/completions`, { headers })
    assert.equal(response.status, 401)
    assert.ok((await response.json()).error.code.endsWith('api_key'))
  }
})

test('disabled keys remain unauthorized and valid keys update usage immutably', async () => {
  const key = { id: 'qa', key: 'local-test-key', enabled: false, usageCount: 0 }
  setConfig({ enableApiKey: true, apiKeys: [key] })
  const blocked = await fetch(`${endpoint}/test-route`, { headers: { 'X-API-Key': key.key } })
  assert.equal(blocked.status, 401)
  await blocked.text()
  setConfig({ enableApiKey: true, apiKeys: [{ ...key, enabled: true }] })
  const allowed = await fetch(`${endpoint}/test-route`, { headers: { Authorization: `Bearer ${key.key}` } })
  assert.equal(allowed.status, 404) // Reached the router, rather than authentication rejection.
  await allowed.text()
  assert.equal(getConfig().apiKeys[0].usageCount, 1)
  assert.equal(key.usageCount, 0)
})

test('CORS preflight permits the documented feature and authentication headers', async () => {
  const response = await fetch(`${endpoint}/v1/chat/completions`, { method: 'OPTIONS' })
  assert.equal(response.status, 204)
  for (const header of ['X-Enable-Vision', 'X-Enable-Thinking', 'X-Reasoning-Effort', 'X-API-Key', 'X-DailyWorkMate-Model-Selection', 'X-Refresh-Free-Models', 'X-OpenCode-Session-Id']) {
    assert.ok(response.headers.get('access-control-allow-headers').includes(header))
  }
})

test('ordinary websites cannot call the local proxy even when API key checking is disabled', async () => {
  setConfig({ enableApiKey: false, apiKeys: [] })
  const response = await fetch(`${endpoint}/test-route`, { headers: { Origin: 'https://untrusted.example' } })
  assert.equal(response.status, 403)
  assert.equal((await response.json()).error.code, 'origin_not_allowed')
})

test('opaque browser origins need the internal desktop key; desktop chat works without public keys', async () => {
  setConfig({ enableApiKey: true, apiKeys: [] })
  const denied = await fetch(`${endpoint}/test-route`, { headers: { Origin: 'null' } })
  assert.equal(denied.status, 403); await denied.text()
  const allowed = await fetch(`${endpoint}/test-route`, { headers: { Origin: 'null', Authorization: `Bearer ${internalProxyKey}` } })
  assert.equal(allowed.status, 404); await allowed.text()
})

test('statistics obey API authentication while health remains accessible', async () => {
  setConfig({ enableApiKey: true, apiKeys: [] })
  const stats = await fetch(`${endpoint}/stats`)
  assert.equal(stats.status, 401); await stats.text()
  const health = await fetch(`${endpoint}/health`)
  assert.equal(health.status, 200)
  assert.equal((await health.json()).version, 'test')
})
