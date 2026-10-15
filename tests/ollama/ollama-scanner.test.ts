import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { build } from 'esbuild'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Bundle extensionless app imports while isolating Electron's persistent stores.
const output = path.resolve('tmp/qa/ollama-scanner-test.mjs')
await mkdir(path.dirname(output), { recursive: true })
after(() => rm(output, { force: true }))
await build({
  entryPoints: ['src/main/ollama/manager.ts'], bundle: true, outfile: output,
  platform: 'node', format: 'esm', packages: 'external',
  plugins: [{ name: 'isolate-scanner-stores', setup(builder) {
    builder.onResolve({ filter: /\/store\/(accounts|providers|store)$/ }, args => ({ path: args.path, namespace: 'qa-store' }))
    builder.onLoad({ filter: /.*/, namespace: 'qa-store' }, () => ({ contents: 'export const AccountManager = {}; export const ProviderManager = {}; export const storeManager = {}' }))
  } }],
})
const { detectVision, discoverModels, probeEndpoint } = await import(pathToFileURL(output).href)

test('scanner falls back to OpenAI model discovery and endpoint while reading Vision metadata', async t => {
  const requests: string[] = []
  const server = createServer((request, response) => {
    requests.push(request.url || '')
    response.setHeader('Content-Type', 'application/json')

    if (request.url === '/v1/models') {
      response.end(JSON.stringify({ data: [{ id: 'vision-model' }] }))
      return
    }
    if (request.url === '/v1/chat/completions') {
      response.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }))
      return
    }
    if (request.url === '/api/show') {
      response.end(JSON.stringify({ capabilities: ['completion', 'vision'] }))
      return
    }

    response.statusCode = 404
    response.end(JSON.stringify({ error: 'not found' }))
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const { port } = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${port}`
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' }

  assert.deepEqual(await discoverModels(baseUrl, headers), ['vision-model'])
  const endpoint = await probeEndpoint(baseUrl, 'vision-model', headers)
  assert.equal(endpoint.endpoint, 'openai_chat')
  assert.equal(typeof endpoint.latency, 'number')
  assert.deepEqual(await detectVision(baseUrl, 'vision-model', headers), {
    vision: 'supported',
    visionSource: 'api-show',
  })
  assert.deepEqual(requests.slice(0, 2), ['/api/tags', '/v1/models'])
  assert.ok(requests.indexOf('/api/chat') < requests.indexOf('/v1/chat/completions'))
})
