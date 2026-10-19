import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const output = path.resolve('tmp/qa/usage-buffer.mjs')
let module, disk, writes, store
before(async () => {
  await mkdir(path.dirname(output), { recursive: true })
  await build({
    stdin: { contents: "export { storeManager } from './src/main/store/store.ts'; export { cachedStore } from './src/main/store/cachedStore.ts'; export { ConfigManager } from './src/main/store/config.ts'; export { DEFAULT_CONFIG } from './src/main/store/types.ts'; export { safeStorageCalls } from 'electron'", resolveDir: process.cwd() },
    outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external',
    plugins: [{ name: 'isolate-electron', setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'qa' }))
      builder.onLoad({ filter: /.*/, namespace: 'qa' }, () => ({ contents: `
        export const safeStorageCalls = { decrypt: 0 }
        export const app = { getLocale: () => 'en-US', setLoginItemSettings: () => {}, getLoginItemSettings: () => ({}) }
        export const safeStorage = { isEncryptionAvailable: () => true,
          encryptString: value => Buffer.from('enc:' + value),
          decryptString: buffer => { safeStorageCalls.decrypt += 1; return buffer.toString().slice(4) } }
        export class BrowserWindow { static getAllWindows() { return [] } }` }))
    } }],
  })
  module = await import(pathToFileURL(output))
})
after(() => rm(output, { force: true }))

const encrypted = value => Buffer.from('enc:' + value).toString('base64')
beforeEach(() => {
  writes = []
  disk = {
    config: { ...module.DEFAULT_CONFIG },
    providers: [{ id: 'p', name: 'P', type: 'custom', enabled: true, apiEndpoint: 'http://x', headers: {}, supportedModels: ['m'], createdAt: 1, updatedAt: 1 }],
    accounts: [{ id: 'a', providerId: 'p', name: 'A', status: 'error', credentials: { token: encrypted('tok') }, createdAt: Date.now(), updatedAt: 1, requestCount: 2 }],
    statistics: { totalRequests: 0, successRequests: 0, failedRequests: 0, totalLatency: 0, modelUsage: {}, modelTokenUsage: {}, providerUsage: {}, accountUsage: {}, dailyStats: {}, lastUpdated: 0 },
  }
  // A persistent store that records every full rewrite, like the encrypted electron-store file.
  const persistent = {
    get store() { return structuredClone(disk) },
    set store(value) { writes.push(Object.keys(value)); disk = structuredClone(value) },
    set(key, value) { writes.push([key]); disk = { ...disk, [key]: structuredClone(value) } },
    delete(key) { const { [key]: _removed, ...rest } = disk; disk = rest },
    clear() { disk = {} },
  }
  store = module.cachedStore(persistent)
  module.storeManager.flushUsage()
  module.storeManager.store = store
  module.storeManager.isInitialized = true
  module.storeManager.pendingAccountUsage = new Map()
  module.storeManager.pendingStatistics = undefined
  module.storeManager.decryptedValues = new Map()
  writes = []
})

test('per-request counters stay in memory, are visible to readers, and reach disk in one flush', () => {
  for (let index = 0; index < 20; index++) {
    module.storeManager.recordAccountUsage('a', { reactivate: true })
    module.storeManager.recordRequestInStats(true, 10, 'm', 'p', 'a')
    module.storeManager.recordTokenUsage('m', 5)
  }
  assert.deepEqual(writes, [], 'no synchronous store write per request')
  const account = module.storeManager.getAccountById('a')
  assert.equal(account.requestCount, 22)
  assert.equal(account.todayUsed, 20)
  assert.equal(account.status, 'active')
  assert.equal(module.storeManager.getStatistics().totalRequests, 20)
  assert.equal(module.storeManager.getStatistics().totalTokens, 100)

  module.storeManager.flushPendingWrites()
  assert.equal(writes.length, 2, 'one write for accounts and one for statistics')
  assert.equal(disk.accounts[0].requestCount, 22)
  assert.equal(disk.accounts[0].status, 'active')
  assert.equal(disk.statistics.totalRequests, 20)
  assert.equal(module.storeManager.getAccountById('a').requestCount, 22, 'flushed counters are not applied twice')
})

test('an explicit account update materializes buffered usage first instead of losing or doubling it', () => {
  module.storeManager.recordAccountUsage('a')
  const current = module.storeManager.getAccountById('a')
  module.storeManager.updateAccount('a', { requestCount: current.requestCount + 1 })
  module.storeManager.flushUsage()
  assert.equal(disk.accounts[0].requestCount, 4)
})

test('client model names cannot grow statistics without bound', () => {
  for (let index = 0; index < 260; index++) module.storeManager.recordRequestInStats(true, 1, `model-${index}`)
  const stats = module.storeManager.getStatistics()
  assert.equal(Object.keys(stats.modelUsage).length, 201)
  assert.equal(stats.modelUsage.other, 60)
})

test('credentials are decrypted once per ciphertext and routing reads do not copy through each other', () => {
  const decryptsBefore = module.safeStorageCalls.decrypt
  const first = module.storeManager.getAccountsByProviderId('p', true)
  const second = module.storeManager.getAccountsByProviderId('p', true)
  assert.equal(first[0].credentials.token, 'tok')
  assert.equal(module.safeStorageCalls.decrypt - decryptsBefore, 1)
  first[0].credentials.token = 'changed'
  assert.equal(second[0].credentials.token, 'tok')
  assert.equal(module.storeManager.getAccountsByProviderId('p', true)[0].credentials.token, 'tok')
  const models = module.storeManager.getEffectiveModels('p')
  models[0].displayName = 'mutated'
  assert.equal(module.storeManager.getEffectiveModels('p')[0].displayName, 'm')
  assert.throws(() => { store.peek('providers')[0].name = 'x' }, TypeError, 'the shared cache is frozen')
})

test('turning key checks off while a LAN listener is configured is refused at both layers', () => {
  const lanKey = { id: 'k', name: 'k', key: 'secret', enabled: true, createdAt: 1, usageCount: 0 }
  store.set('config', { ...module.DEFAULT_CONFIG, proxyHost: '0.0.0.0', enableApiKey: true, apiKeys: [lanKey] })
  const refused = module.ConfigManager.validate({ enableApiKey: false })
  assert.equal(refused.valid, false)
  assert.match(refused.errors.join(' '), /0\.0\.0\.0/)
  assert.equal(module.ConfigManager.validate({ apiKeys: [] }).valid, false)
  assert.throws(() => module.storeManager.updateConfig({ apiKeys: [] }), /0\.0\.0\.0/)
  assert.equal(module.ConfigManager.validate({ proxyHost: '127.0.0.1', enableApiKey: false }).valid, true)
  // An already unprotected setup stays editable so it can be repaired.
  store.set('config', { ...module.DEFAULT_CONFIG, proxyHost: '0.0.0.0', enableApiKey: false, apiKeys: [] })
  assert.doesNotThrow(() => module.storeManager.updateConfig({ theme: 'dark' }))
})

test('imported settings with malformed nested sections are rejected before they can break routing', () => {
  for (const config of [
    { ollamaRouting: { forceModel: true, model: 42 } },
    { ollamaRouting: 'fixed' },
    { sessionConfig: { sessionTimeout: -1 } },
    { sessionConfig: { maxMessagesPerSession: 0 } },
    { contextManagement: { enabled: 'yes' } },
    { contextManagement: { strategies: { slidingWindow: { maxMessages: 'many' } } } },
    { contextManagement: { executionOrder: ['slidingWindow', 'everything'] } },
  ]) assert.equal(module.ConfigManager.validate(config).valid, false, JSON.stringify(config))
  assert.equal(module.ConfigManager.validate({
    ollamaRouting: { forceModel: false, model: '', autoSelectUrl: true, providerId: '' },
    sessionConfig: { sessionTimeout: 30, maxMessagesPerSession: 50, deleteAfterTimeout: false, maxSessionsPerAccount: 3 },
    contextManagement: module.DEFAULT_CONFIG.contextManagement,
  }).valid, true)
})
