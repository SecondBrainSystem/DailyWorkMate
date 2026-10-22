import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import Koa from 'koa'
const storeFixture = "\nexport const state = { providers: [], accounts: [], config: {modelMappings:{},loadBalanceStrategy:'round-robin'} };\nexport const storeManager = {\n getConfig: () => state.config, getProviders: () => state.providers,\n getAccountsByProviderId: id => state.accounts.filter(a => a.providerId === id),\n getEffectiveModels: id => (state.providers.find(p => p.id === id)?.supportedModels || []).map(name => ({displayName:name,actualModelId:name})),\n};"
const output = path.resolve('tmp/qa/model-catalog-test.mjs')
let api, server, endpoint
before(async () => {
  await mkdir(path.dirname(output), { recursive: true })
  await build({
    stdin: { contents: "export { default as models } from './src/main/proxy/routes/models.ts'; export { listAvailableModels } from './src/main/proxy/modelCatalog.ts'; export { loadBalancer } from './src/main/proxy/loadbalancer.ts'; export { state } from './src/main/store/store'; export { KiloFreeModelCatalogue } from './src/main/inference/kiloModels.ts'; export { OpenCodeFreeModelCatalogue } from './src/main/companion/opencodeModels.ts'", resolveDir: process.cwd() },
    outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external',
    plugins: [{ name: 'isolate-model-catalog', setup(builder) {
      builder.onResolve({ filter: /\/store\/store(?:\.ts)?$/ }, () => ({ path: 'store', namespace: 'qa' }))
      builder.onLoad({ filter: /.*/, namespace: 'qa' }, () => ({ contents: storeFixture }))
    } }],
  })
  api = await import(pathToFileURL(output))
  for (const catalogue of [api.KiloFreeModelCatalogue, api.OpenCodeFreeModelCatalogue]) {
    test.mock.method(catalogue.prototype, 'get', async () => ({ models: [], stale: false, updatedAt: 1000 }))
  }
  const app = new Koa()
  app.use(api.models.routes())
  server = createServer(app.callback())
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  endpoint = 'http://127.0.0.1:' + server.address().port
})
beforeEach(() => {
  api.state.providers = [
    {id:'ready', name:'Ready', enabled:true, createdAt:1000, supportedModels:['usable'], upstreamKind:'ollama', ollamaModels:{usable:{endpoint:'ollama_chat'}}},
    {id:'disabled', name:'Disabled', enabled:false, createdAt:1000, supportedModels:['disabled-model']},
    {id:'unprobed', name:'Unprobed', enabled:true, createdAt:1000, supportedModels:['unprobed-model'], upstreamKind:'ollama', ollamaModels:{'unprobed-model':{}}},
  ]
  api.state.accounts = api.state.providers.map(p => ({id:p.id,providerId:p.id,status:'active',dailyLimit:10,todayUsed:0}))
  api.state.config = { loadBalanceStrategy:'round-robin', modelMappings:{
    alias:{actualModel:'usable',preferredProviderId:'ready'},
    ghost:{actualModel:'disabled-model',preferredProviderId:'disabled'},
    missing:{actualModel:'absent',preferredProviderId:'deleted'},
  }}
  api.loadBalancer.resetRoundRobinIndex()
  for (const a of api.state.accounts) api.loadBalancer.clearAccountFailure(a.id)
})
after(async () => {
  server?.closeAllConnections()
  if (server) await new Promise(resolve => server.close(resolve))
  await rm(output, {force:true})
})
const list = async () => (await (await fetch(endpoint + '/v1/models')).json()).data.map(m => m.id).sort()

test('catalog excludes disabled/deleted mappings and Ollama models without a proven endpoint', async () => {
  assert.deepEqual(await list(), ['alias', 'usable'])
  for (const id of ['ghost','missing','unprobed-model']) assert.equal((await fetch(endpoint + '/v1/models/' + id)).status, 404)
  assert.equal((await fetch(endpoint + '/v1/models/alias')).status, 200)
})
test('exhausted accounts and empty account pools are not advertised', async () => {
  api.state.accounts = api.state.accounts.map(a => ({...a,todayUsed:10}))
  assert.deepEqual(await list(), [])
  assert.equal((await fetch(endpoint + '/v1/models/usable')).status, 404)
  api.state.accounts = []
  assert.deepEqual(await list(), [])
})

test('desktop catalog and HTTP return the same models without starting or advancing routing', async () => {
  api.state.providers = api.state.providers.map(provider => provider.id === 'ready' ? {
    ...provider, supportedModels:['usable','other'], ollamaModels:{...provider.ollamaModels, other:{endpoint:'ollama_chat',testStatus:'untested'}},
  } : provider)
  api.state.accounts = [...api.state.accounts, {...api.state.accounts[0],id:'second'}]
  assert.equal(api.loadBalancer.selectAccount('usable').account.id, 'ready')
  const direct = api.listAvailableModels()
  assert.deepEqual(direct.map(model => model.id).sort(), ['alias','other','usable'])
  assert.deepEqual(direct, (await (await fetch(endpoint + '/v1/models')).json()).data)
  assert.equal(api.loadBalancer.selectAccount('usable').account.id, 'second')
})
test('catalog lists models routing can still reach, without advancing round robin', async () => {
  api.state.accounts = [...api.state.accounts, {...api.state.accounts[0],id:'second'}]
  assert.equal(api.loadBalancer.selectAccount('usable').account.id, 'ready')
  await list()
  assert.equal(api.loadBalancer.selectAccount('usable').account.id, 'second')
  for (const id of ['ready','second']) for (let i=0;i<3;i++) api.loadBalancer.markAccountFailed(id)
  assert.deepEqual(await list(), ['alias','usable'])
  api.state.config = {...api.state.config,loadBalanceStrategy:'failover'}
  // Failover falls back to the least-failed account when all cool down, so the catalog keeps the models.
  assert.deepEqual(await list(), ['alias','usable'])
  assert.ok(api.loadBalancer.selectAccount('usable', 'failover'), 'failover still routes while every account cools down')
})
