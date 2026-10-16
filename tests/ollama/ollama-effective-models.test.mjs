import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const output = path.resolve('tmp/qa/ollama-effective-models.mjs')
let storeManager
before(async () => {
  await mkdir(path.dirname(output), { recursive: true })
  await build({
    entryPoints: ['src/main/store/store.ts'], outfile: output,
    bundle: true, platform: 'node', format: 'esm', packages: 'external',
    plugins: [{ name: 'isolate-electron', setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'qa' }))
      builder.onLoad({ filter: /.*/, namespace: 'qa' }, () => ({ contents: 'export const app = {}; export const safeStorage = {}; export class BrowserWindow {}' }))
    } }],
  })
  ;({ storeManager } = await import(pathToFileURL(output)))
})
after(() => rm(output, { force: true }))

test('effective catalog excludes failed, untested and offline models including custom aliases, while retaining user exclusions', () => {
  const metadata = testStatus => ({ name: 'model', endpoint: 'ollama_chat', vision: 'unknown', testStatus })
  const provider = {
    id: 'node', upstreamKind: 'ollama', status: 'online',
    supportedModels: ['passed', 'failed', 'pending', 'excluded'],
    ollamaModels: { passed: metadata('passed'), failed: metadata('failed'), pending: { name:'pending', vision:'unknown', testStatus:'untested' }, excluded: metadata('passed') },
  }
  let data = { providers: [provider], userModelOverrides: { node: {
    excludedModels: ['excluded'], addedModels: [{ displayName:'failed-alias', actualModelId:'failed' }, { displayName:'healthy-alias', actualModelId:'passed' }],
  } } }
  storeManager.store = { get: key => structuredClone(data[key]) }
  storeManager.isInitialized = true
  const initial = structuredClone(data)
  assert.deepEqual(storeManager.getEffectiveModels('node').map(model => model.displayName), ['passed', 'healthy-alias'])
  assert.deepEqual(data, initial, 'availability filtering must not overwrite exclusions or evidence')
  data = { ...data, providers: [{ ...provider, status:'offline' }] }
  assert.deepEqual(storeManager.getEffectiveModels('node'), [])
  data = { ...data, providers: [{ ...provider, ollamaModels: { ...provider.ollamaModels, failed: metadata('passed') } }] }
  assert.deepEqual(storeManager.getEffectiveModels('node').map(model => model.displayName), ['passed', 'failed', 'failed-alias', 'healthy-alias'])
  assert.deepEqual(data.userModelOverrides.node.excludedModels, ['excluded'])
})
