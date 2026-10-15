import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const output = path.resolve('tmp/qa/config-stores.mjs')
let module, config, writes, fail, values
before(async () => {
  values = new Map()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) } })
  globalThis.window = { localStorage: globalThis.localStorage }
  await mkdir(path.dirname(output), { recursive: true })
  await build({
    stdin: { contents: "export { useProxyStore } from './src/renderer/src/stores/proxyStore.ts'; export { useSettingsStore } from './src/renderer/src/stores/settingsStore.ts'; export { DEFAULT_CONFIG } from './src/main/store/types.ts'", resolveDir: process.cwd() },
    outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external',
    plugins: [{ name: 'isolate-ui', setup(builder) {
      builder.onResolve({ filter: /^@\/(i18n|hooks\/use-toast)$/ }, args => ({ path: args.path, namespace: 'qa' }))
      builder.onLoad({ filter: /.*/, namespace: 'qa' }, () => ({ contents: "export default { changeLanguage: async () => {}, t: value => value }; export const toast = () => {}" }))
    } }],
  })
  module = await import(pathToFileURL(output))
})
after(async () => { delete globalThis.window; delete globalThis.localStorage; await rm(output, { force: true }) })
beforeEach(() => {
  config = structuredClone(module.DEFAULT_CONFIG)
  writes = []; fail = false; values.clear()
  globalThis.window = { localStorage: globalThis.localStorage, electronAPI: {
    config: { get: async () => structuredClone(config), update: async updates => {
      if (fail) throw new Error('Disk write failed')
      writes.push(structuredClone(updates)); config = { ...config, ...updates }; return true
    } },
    store: { get: async () => structuredClone(config), set: async (_key, value) => {
      if (fail) throw new Error('Disk write failed')
      writes.push(structuredClone(value)); config = structuredClone(value)
    } },
  } }
  module.useProxyStore.setState({ appConfig: null, isLoading: false, error: null })
  module.useSettingsStore.setState({ config: null })
})

test('proxy save patches the authoritative config without overwriting newer API keys', async () => {
  await module.useProxyStore.getState().fetchAppConfig()
  config = { ...config, enableApiKey: true, apiKeys: [{ id: 'new', key: 'new-secret', enabled: true }] }
  assert.equal(await module.useProxyStore.getState().saveAppConfig({ retryCount: 1 }), true)
  assert.deepEqual(writes, [{ retryCount: 1 }])
  assert.equal(config.enableApiKey, true)
  assert.equal(config.apiKeys[0].id, 'new')
  assert.equal(module.useProxyStore.getState().appConfig.apiKeys[0].id, 'new')
})

test('settings save before initial fetch persists and reports success', async () => {
  assert.equal(await module.useSettingsStore.getState().updateConfig({ enableApiKey: true }), true)
  assert.equal(config.enableApiKey, true)
  assert.equal(module.useSettingsStore.getState().config.enableApiKey, true)
})

test('settings reports failure and retains the last confirmed configuration', async () => {
  await module.useSettingsStore.getState().fetchConfig()
  fail = true
  assert.equal(await module.useSettingsStore.getState().updateConfig({ enableApiKey: true }), false)
  assert.equal(module.useSettingsStore.getState().config.enableApiKey, false)
})

test('tray and logging settings reach the main process and are restored from it', async () => {
  await module.useSettingsStore.getState().fetchConfig()
  await module.useSettingsStore.getState().setMinimizeToTray(false)
  await module.useSettingsStore.getState().setLogLevel('error')
  await module.useSettingsStore.getState().setLogRetentionDays(7)
  assert.equal(config.minimizeToTray, false)
  assert.equal(config.logLevel, 'error')
  assert.equal(config.logRetentionDays, 7)
  module.useSettingsStore.getState().setConfig({ ...config, minimizeToTray: true, logLevel: 'warn' })
  assert.equal(module.useSettingsStore.getState().minimizeToTray, true)
  assert.equal(module.useSettingsStore.getState().logLevel, 'warn')
})
test('queued settings writes recover from failure without rolling back a later save', async () => {
  const update = window.electronAPI.config.update
  let active = 0, peak = 0
  window.electronAPI.config.update = async updates => {
    active++; peak = Math.max(peak, active)
    try {
      await new Promise(resolve => setTimeout(resolve, 15))
      if (updates.logLevel === 'debug') throw new Error('First write failed')
      return await update(updates)
    } finally { active-- }
  }
  await module.useSettingsStore.getState().fetchConfig()
  const first = module.useSettingsStore.getState().updateConfig({ logLevel: 'debug' })
  const second = module.useSettingsStore.getState().updateConfig({ minimizeToTray: false })
  assert.equal(module.useSettingsStore.getState().isSaving, true)
  assert.deepEqual(await Promise.all([first, second]), [false, true])
  assert.equal(peak, 1)
  assert.equal(config.logLevel, 'info')
  assert.equal(module.useSettingsStore.getState().config.minimizeToTray, false)
  assert.equal(module.useSettingsStore.getState().isSaving, false)
})

test('saving state is not persisted and stale saving flags are ignored on reload', async () => {
  module.useSettingsStore.setState({ isSaving: true })
  const stored = JSON.parse(values.get('dailyworkmate-settings'))
  assert.equal('isSaving' in stored.state, false)
  values.set('dailyworkmate-settings', JSON.stringify({ ...stored, state: { ...stored.state, isSaving: true } }))
  await module.useSettingsStore.persist.rehydrate()
  assert.equal(module.useSettingsStore.getState().isSaving, false)
})
