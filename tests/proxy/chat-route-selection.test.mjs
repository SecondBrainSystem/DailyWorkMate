import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import { mkdir, rm } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import Koa from 'koa'
import bodyParser from 'koa-bodyparser'

const output = path.resolve('tmp/qa/chat-route-selection.mjs')
let server, endpoint, module
before(async () => {
  await mkdir(path.dirname(output), { recursive: true })
  await build({
    stdin: { contents: `export { default as router } from './src/main/proxy/routes/chat.ts'; export { getSelection } from './src/main/proxy/loadbalancer'; export { setConfig } from './src/main/store/store'`, resolveDir: process.cwd() },
    outfile: output, bundle: true, format: 'esm', platform: 'node', packages: 'external',
    plugins: [{ name: 'isolate-chat-route', setup(builder) {
      builder.onResolve({ filter: /\/ollamaQuality$/ }, () => ({ path: 'quality', namespace: 'quality' }))
      builder.onLoad({ filter: /.*/, namespace: 'quality' }, () => ({ contents: 'export const ollamaQuality = { verify: async () => ({success:true}) }' }))
      builder.onResolve({ filter: /\/(?:store\/store|loadbalancer|forwarder|stream|modelMapper)$/ }, args => ({ path: args.path.split('/').at(-1), namespace: 'qa' }))
      builder.onLoad({ filter: /.*/, namespace: 'qa' }, args => ({ resolveDir: process.cwd(), contents: {
        store: `let config = {}; export const getConfig = () => config; export const setConfig = value => { config = value }; export const storeManager = { getConfig: () => config }`,
        loadbalancer: `let selected; export const getSelection = () => selected; export const loadBalancer = { selectAccount: (...args) => { selected = args; return undefined } }`,
        forwarder: 'export const requestForwarder = {}',
        stream: 'export const streamHandler = {}',
        modelMapper: `import { getConfig } from './src/main/store/store'; export const modelMapper = { getPreferredProvider: () => getConfig().modelPin || (!getConfig().ollamaRouting?.forceModel || getConfig().explicitTest ? 'normal-provider' : undefined), getPreferredAccount: () => 'normal-account' }`,
      }[args.path] }))
    } }],
  })
  module = await import(pathToFileURL(output).href)
  const app = new Koa()
  app.use(bodyParser()); app.use(module.router.routes())
  server = http.createServer(app.callback())
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`
})

test('AI Chat explicit selection wins over forced Ollama model and node', async () => {
  module.setConfig({ explicitTest: true, ollamaRouting: { forceModel: true, model: 'default-node-model', providerId: 'node-1', autoSelectUrl: true }, loadBalanceStrategy: 'round-robin' })
  for (const model of ['qwen3:8b', 'other-provider-model']) {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-DailyWorkMate-Model-Selection': 'explicit' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }) })
    assert.equal(response.status, 503)
    await response.text()
    assert.deepEqual(module.getSelection(), [model, 'round-robin', 'normal-provider', 'normal-account', undefined])
  }
})
after(async () => {
  server?.closeAllConnections()
  if (server) await new Promise(resolve => server.close(resolve))
  await rm(output, { force: true })
})

test('OpenAI chat route honors forced Ollama model/node and normal routing', async () => {
  for (const [routing, expected] of [
    [{ forceModel: true, model: 'qwen3:8b', providerId: 'node-1', autoSelectUrl: false }, ['qwen3:8b', 'round-robin', 'node-1', undefined, 'ollama']],
    [{ forceModel: true, model: 'qwen3:8b', providerId: 'node-1', autoSelectUrl: true }, ['qwen3:8b', 'round-robin', undefined, undefined, 'ollama']],
    [{ forceModel: false, autoSelectUrl: false }, ['requested', 'round-robin', 'normal-provider', 'normal-account', undefined]],
  ]) {
    module.setConfig({ ollamaRouting: routing, loadBalanceStrategy: 'round-robin' })
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'requested', messages: [{ role: 'user', content: 'hi' }] }) })
    assert.equal(response.status, 503) // The isolated load balancer records selection, then returns no account.
    await response.text()
    assert.deepEqual(module.getSelection(), expected)
  }
})
