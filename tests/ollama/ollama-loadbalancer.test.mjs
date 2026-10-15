import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const output = path.resolve('tmp/qa/ollama-loadbalancer.mjs')
let LoadBalancer, setState
before(async () => {
  await mkdir(path.dirname(output), { recursive: true })
  await build({
    stdin: { contents: "export { LoadBalancer } from './src/main/proxy/loadbalancer.ts'; export { setState } from './src/main/store/store'", resolveDir: process.cwd() },
    outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external',
    plugins: [{ name: 'isolate-balancer', setup(builder) {
      builder.onResolve({ filter: /\/store\/store$/ }, () => ({ path: 'store', namespace: 'qa' }))
      builder.onLoad({ filter: /.*/, namespace: 'qa' }, () => ({ contents: `
        let state; export const setState = value => { state = value };
        export const storeManager = {
          getProviders: () => state.providers,
          getEffectiveModels: id => state.models[id] || [],
          getAccountsByProviderId: id => [{id: id + '-account', providerId: id, status: 'active'}],
          getConfig: () => ({modelMappings: state.mappings || {}}),
        };
      ` }))
    } }],
  })
  ;({ LoadBalancer, setState } = await import(pathToFileURL(output)))
})
after(() => rm(output, { force: true }))

const node = { id: 'node', name: 'Node', enabled: true, upstreamKind: 'ollama', supportedModels: ['model'], ollamaModels: { model: { endpoint: 'ollama_chat' } } }
test('unscanned and fully disabled Ollama nodes cannot catch arbitrary models', () => {
  for (const provider of [node, { ...node, supportedModels: [], ollamaModels: {} }]) {
    setState({ providers: [provider], models: {} })
    assert.equal(new LoadBalancer().selectAccount('model'), null)
    assert.equal(new LoadBalancer().selectAccount('unknown'), null)
  }
})

test('a pinned provider does not bypass model exclusions or failed endpoint probes', () => {
  setState({ providers: [node], models: { node: [{ displayName: 'other', actualModelId: 'other' }] }, mappings: { alias: { actualModel: 'model', preferredProviderId: 'node' } } })
  assert.equal(new LoadBalancer().selectAccount('alias', 'round-robin', 'node'), null)
  setState({ providers: [{ ...node, ollamaModels: { model: { error: 'probe failed' } } }], models: { node: [{ displayName: 'model', actualModelId: 'model' }] } })
  assert.equal(new LoadBalancer().selectAccount('model'), null)
})

test('healthy aliases route to their actual model and generic unconfigured APIs still work', () => {
  setState({ providers: [node], models: { node: [{ displayName: 'model', actualModelId: 'model' }] }, mappings: { alias: { actualModel: 'model', preferredProviderId: 'node' } } })
  assert.equal(new LoadBalancer().selectAccount('alias', 'round-robin', 'node')?.actualModel, 'model')
  setState({ providers: [{ id: 'generic', enabled: true, type: 'custom' }], models: {} })
  assert.equal(new LoadBalancer().selectAccount('arbitrary')?.actualModel, 'arbitrary')
})
