import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const output = path.resolve('tmp/qa/account-usage.mjs')
let module, data
before(async () => {
  await mkdir(path.dirname(output), { recursive: true })
  await build({
    stdin: { contents: "export { storeManager } from './src/main/store/store.ts'; export { AccountManager } from './src/main/store/accounts.ts'; export { LoadBalancer } from './src/main/proxy/loadbalancer.ts'", resolveDir: process.cwd() },
    outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external',
    plugins: [{ name: 'isolate-electron', setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'qa' }))
      builder.onLoad({ filter: /.*/, namespace: 'qa' }, () => ({ contents: 'export const app = {}; export const safeStorage = { isEncryptionAvailable: () => false }; export class BrowserWindow {}' }))
    } }],
  })
  module = await import(pathToFileURL(output))
})
after(() => rm(output, { force: true }))
beforeEach(() => {
  data = { accounts: [], providers: [{ id: 'node', name: 'Node', enabled: true, type: 'custom', supportedModels: [] }] }
  module.storeManager.store = { get: key => structuredClone(data[key]), set: (key, value) => { data = { ...data, [key]: structuredClone(value) } } }
  module.storeManager.isInitialized = true
})
const account = (id, updates = {}) => ({ id, providerId: 'node', name: id, status: 'active', credentials: {}, createdAt: Date.now(), updatedAt: Date.now(), ...updates })

test('yesterday quota recovers across every account reader without rewriting storage', () => {
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  data.accounts = [account('limited', { dailyLimit: 2, todayUsed: 2, lastUsed: yesterday.getTime() })]
  const original = structuredClone(data)
  for (const read of [() => module.storeManager.getAccounts(), () => module.storeManager.getAccounts(true), () => module.storeManager.getAccountsByProviderId('node'), () => module.storeManager.getActiveAccounts()]) {
    assert.equal(read()[0].todayUsed, 0)
  }
  assert.equal(module.storeManager.getAccountById('limited').todayUsed, 0)
  assert.equal(module.AccountManager.isAvailable('limited'), true)
  assert.equal(new module.LoadBalancer().selectAccount('model')?.account.id, 'limited')
  assert.deepEqual(data, original)
  module.AccountManager.incrementRequestCount('limited')
  assert.equal(data.accounts[0].todayUsed, 1)
  assert.equal(data.accounts[0].requestCount, 1)
})

test('today quota stays enforced and requests count toward the current day', () => {
  data.accounts = [account('limited', { dailyLimit: 2, todayUsed: 2, lastUsed: Date.now() })]
  assert.equal(module.AccountManager.isAvailable('limited'), false)
  assert.equal(new module.LoadBalancer().selectAccount('model'), null)
})

test('fill-first keeps using the first eligible account until its limit', () => {
  data.accounts = [account('first', { todayUsed: 1, dailyLimit: 2, lastUsed: Date.now() }), account('second', { todayUsed: 0 })]
  const balancer = new module.LoadBalancer()
  assert.equal(balancer.selectAccount('model', 'fill-first')?.account.id, 'first')
  assert.equal(module.AccountManager.selectNext('node', 'fill-first')?.id, 'first')
  module.AccountManager.incrementRequestCount('first')
  assert.equal(balancer.selectAccount('model', 'fill-first')?.account.id, 'second')
  assert.equal(module.AccountManager.selectNext('node', 'fill-first')?.id, 'second')
})