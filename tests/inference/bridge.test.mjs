import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import { mkdir, rm } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const output = path.resolve('tmp/qa/internal-bridge-test.mjs')
let module
before(async () => {
  await mkdir(path.dirname(output), { recursive: true })
  await build({
    stdin: { contents: `export { InternalInferenceBridge, INTERNAL_INFERENCE_PORTS } from './src/main/inference/bridge.ts'; export { ProxyServer } from './src/main/proxy/server.ts'; export { proxyStatusManager } from './src/main/proxy/status.ts'; export { state, reset } from 'bridge-test-state'`, resolveDir: process.cwd() },
    outfile: output, bundle: true, format: 'esm', platform: 'node', packages: 'external',
    plugins: [{ name: 'isolate-internal-bridge', setup(builder) {
      builder.onResolve({ filter: /^(?:electron|node:http|bridge-test-state)$/ }, args => ({ path: args.path, namespace: 'qa' }))
      builder.onResolve({ filter: /(?:\/store\/store$|(?:\/proxy)?\/routes(?:\/management)?$)/ }, args => ({ path: args.path.includes('/store/') ? 'store' : args.path.endsWith('/management') ? 'management' : 'routes', namespace: 'qa' }))
      builder.onLoad({ filter: /.*/, namespace: 'qa' }, args => ({ resolveDir: process.cwd(), contents: {
        'bridge-test-state': `export let state; export const reset = () => {state = {attempts:[], logs:[], explicit:undefined, stream:undefined, config:{}}}; reset();`,
        electron: `export const app = {getVersion: () => 'test'}; export const BrowserWindow = {getAllWindows: () => []};`,
        'node:http': `import {createServer as actualCreateServer} from 'http'; import {state} from 'bridge-test-state';
          export const createServer = (...args) => {const server=actualCreateServer(...args),listen=server.listen.bind(server);
            server.listen=(port,host,callback)=>{state.attempts.push(port); if(port) {queueMicrotask(()=>server.emit('error',Object.assign(new Error('Synthetic reserved/busy preferred port'),{code:port%2?'EACCES':'EADDRINUSE'}))); return server} return listen(port,host,callback)}; return server};`,
        store: `import {state} from 'bridge-test-state'; export const storeManager = {getConfig:()=>({...state.config,proxyPort:state.config.proxyPort??11434,proxyHost:'127.0.0.1',enableApiKey:false,apiKeys:[],requestTimeout:120000,retryCount:0,managementApi:{enableManagementApi:true,managementApiSecret:'test-only'}}),addLog:(...args)=>state.logs.push(args),addRequestLog:()=>({id:'test-log'})};`,
        management: `import Router from '@koa/router'; const router=new Router(); router.get('/v0/management/config',ctx=>{ctx.body={privateManagement:true}}); export default [router];`,
        routes: `import Router from '@koa/router'; import {PassThrough} from 'node:stream'; import {state} from 'bridge-test-state';
          const router=new Router(); router.get('/v1/models',ctx=>{state.explicit=ctx.get('x-dailyworkmate-model-selection');ctx.body={object:'list',data:[{id:'remote-model'}]}});
          router.post('/v1/chat/completions',ctx=>{const stream=new PassThrough();state.stream=stream;ctx.type='text/event-stream';ctx.body=stream;stream.write('data: {"content":"before stop"}\\n\\n')}); export default [router];`,
      }[args.path] }))
    } }],
  })
  module = await import(pathToFileURL(output).href)
})
beforeEach(() => module.reset())
after(async () => { await rm(output, { force: true }) })

async function freePort() {
  const server = http.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

test('busy or Windows-reserved 11435–11439 fall back to OS allocation without trying 11434', async () => {
  const bridge = new module.InternalInferenceBridge()
  try {
    const first = bridge.connection(), second = bridge.connection()
    assert.equal(first, second)
    const connection = await first
    assert.deepEqual(module.state.attempts, [...module.INTERNAL_INFERENCE_PORTS, 0])
    assert.notEqual(new URL(connection.baseURL).port, '11434')
    assert.equal(new URL(connection.baseURL).hostname, '127.0.0.1')
    assert.deepEqual(await bridge.connection(), connection)
    assert.equal(module.state.attempts.length, 6)
  } finally { await bridge.stop() }
})

test('the bridge never takes a port configured for the proxy or an additional listener', async () => {
  module.state.config = { proxyPort: 11436, additionalProxyListeners: [{ port: 11438, host: '0.0.0.0' }] }
  const bridge = new module.InternalInferenceBridge()
  try {
    await bridge.connection()
    assert.deepEqual(module.state.attempts, [11435, 11437, 11439, 0])
  } finally { await bridge.stop() }
})

test('stopping a bridge whose start failed does not interrupt shutdown', async () => {
  const bridge = new module.InternalInferenceBridge()
  bridge.start = () => Promise.reject(new Error('no port'))
  await assert.rejects(bridge.connection(), /no port/)
  const failing = bridge.connection()
  await assert.doesNotReject(bridge.stop())
  await assert.rejects(failing, /no port/)
})

test('native bridge accepts its ephemeral Bearer or x-api-key and preserves explicit model selection', async () => {
  const bridge = new module.InternalInferenceBridge()
  try {
    const connection = await bridge.connection()
    for (const headers of [{Authorization:`Bearer ${connection.apiKey}`}, {'x-api-key':connection.apiKey}]) {
      const response = await fetch(`${connection.baseURL}/models`, {headers:{...headers,'x-dailyworkmate-model-selection':'automatic'}})
      assert.equal(response.status, 200)
      assert.equal((await response.json()).data[0].id, 'remote-model')
      assert.equal(module.state.explicit, 'explicit')
    }
    for (const headers of [{}, {Authorization:'Bearer unknown'}, {'x-api-key':'unknown'}]) {
      const response = await fetch(`${connection.baseURL}/models`, {headers})
      assert.equal(response.status, 401)
      await response.text()
    }
  } finally { await bridge.stop() }
})

test('native bridge rejects browser origins and never registers management endpoints', async () => {
  const bridge = new module.InternalInferenceBridge()
  try {
    const connection = await bridge.connection()
    for (const Origin of ['null', 'https://untrusted.example', 'http://127.0.0.1']) {
      const response = await fetch(`${connection.baseURL}/models`, {headers:{Origin,Authorization:`Bearer ${connection.apiKey}`}})
      assert.equal(response.status, 403)
      await response.text()
    }
    const response = await fetch(`${connection.baseURL.replace(/\/v1$/, '')}/v0/management/config`, {headers:{Authorization:`Bearer ${connection.apiKey}`}})
    assert.equal(response.status, 404)
    assert.doesNotMatch(await response.text(), /privateManagement/)
  } finally { await bridge.stop() }
})

test('stopping public API listeners leaves native bridge streams and in-flight request accounting alive', async () => {
  const bridge = new module.InternalInferenceBridge()
  const publicProxy = new module.ProxyServer()
  let reader
  try {
    const port = await freePort()
    assert.equal(await publicProxy.start(port, '127.0.0.1'), true)
    const connection = await bridge.connection()
    const response = await fetch(`${connection.baseURL}/chat/completions`, {method:'POST',headers:{Authorization:`Bearer ${connection.apiKey}`,'Content-Type':'application/json'},body:JSON.stringify({model:'remote-model',messages:[{role:'user',content:'test'}],stream:true})})
    reader = response.body.getReader()
    assert.match(new TextDecoder().decode((await reader.read()).value), /before stop/)
    module.proxyStatusManager.recordRequestStart('remote-model')
    assert.equal(await publicProxy.stop(), true)
    assert.equal(publicProxy.isRunning(), false)
    assert.equal(module.proxyStatusManager.getStatistics().activeConnections, 1)
    module.state.stream.end('data: {"content":"after stop"}\n\ndata: [DONE]\n\n')
    let remainder = ''
    while (true) { const chunk = await reader.read(); if (chunk.done) break; remainder += new TextDecoder().decode(chunk.value) }
    assert.match(remainder, /after stop/)
    assert.match(remainder, /\[DONE\]/)
    module.proxyStatusManager.recordRequestSuccess(1)
    const stillListening = await fetch(`${connection.baseURL}/models`, {headers:{'x-api-key':connection.apiKey}})
    assert.equal(stillListening.status, 200)
    await stillListening.text()
  } finally { await reader?.cancel(); await publicProxy.stop(); await bridge.stop() }
})
