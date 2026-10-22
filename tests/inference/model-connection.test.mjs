import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const output = path.resolve('tmp/qa/model-connection-test.mjs')
let directModelConnection, resolveModelConnection, state, kiloFreeModels
before(async () => {
  await mkdir(path.dirname(output), { recursive: true })
  await build({ stdin: { contents: `
    export { directModelConnection } from './src/main/inference/directConnection.ts'
    export { resolveModelConnection } from './src/main/inference/modelConnection.ts'
    export { state } from './src/main/store/store'
    export { kiloFreeModels } from './src/main/inference/kiloModels.ts'
  `, resolveDir: process.cwd() }, outfile: output, bundle: true, format: 'esm', platform: 'node', packages: 'external',
  plugins: [{ name: 'isolated-resolution', setup(builder) {
    builder.onResolve({ filter: /(?:\/store\/store$|\/proxy\/(?:loadbalancer|modelMapper)$|^\.\/bridge$)/ }, () => ({ path: 'state', namespace: 'qa' }))
    builder.onLoad({ filter: /.*/, namespace: 'qa' }, () => ({ contents: `
      export const state = { selection: null, calls: [], bridgeStarts: 0, pinned: true }
      export const storeManager = { getConfig: () => ({ loadBalanceStrategy: 'round-robin', ollamaRouting: { forceModel: true, model: 'unrelated-public-default' } }) }
      export const modelMapper = { getPreferredProvider: model => 'provider-for-' + model, getPreferredAccount: model => state.pinned ? 'account-for-' + model : undefined }
      export const loadBalancer = { selectAccount: (...args) => { state.calls.push(args); return state.selection } }
      export const internalInferenceBridge = { connection: async () => { state.bridgeStarts++; return { baseURL: 'http://127.0.0.1:11435/v1', apiKey: 'internal-only' } } }
    ` }))
  } }] })
  ;({ directModelConnection, resolveModelConnection, state, kiloFreeModels } = await import(pathToFileURL(output)))
})
after(async () => { await rm(output, { force: true }) })

function selection(overrides = {}, credentials = { apiKey: 'test-key' }) {
  return { actualModel: 'real-model', provider: { id: 'node', name: 'Remote model', apiEndpoint: 'http://192.0.2.8:9000/v1', chatPath: '/chat/completions', headers: {}, upstreamKind: 'api', apiProtocol: 'openai', ...overrides }, account: { id: 'native-account', credentials } }
}

test('OpenAI native client uses the real endpoint, mapped model and account key', async () => {
  state.selection = selection()
  const starts = state.bridgeStarts
  const connection = await resolveModelConnection('display-alias', 'opencode')
  assert.deepEqual(connection, { baseURL: 'http://192.0.2.8:9000/v1', apiKey: 'test-key', model: 'real-model', protocol: 'openai', direct: true, headers: { authorization: 'Bearer test-key' } })
  assert.equal(state.bridgeStarts, starts)
  assert.deepEqual(state.calls.at(-1), ['display-alias', 'round-robin', 'provider-for-display-alias', 'account-for-display-alias', undefined, [], false])
})

test('Anthropic base URL works for both native clients and preserves custom gateway paths', () => {
  const upstream = selection({ apiProtocol: 'anthropic', apiEndpoint: 'https://example.test/gateway', chatPath: '/v1/messages' })
  for (const consumer of ['claude', 'opencode']) {
    const direct = directModelConnection(upstream, consumer)
    assert.equal(direct.baseURL, 'https://example.test/gateway/v1')
    assert.equal(direct.protocol, 'anthropic')
    assert.equal(direct.headers['x-api-key'], 'test-key')
  }
})

test('a native runtime retains its account preference and re-reads changed credentials and explicit pins', async () => {
  state.pinned = false
  try {
    state.selection = selection()
    await resolveModelConnection('sticky-model', 'opencode')
    assert.equal(state.calls.at(-1)[3], undefined)
    state.selection = selection({}, { apiKey: 'rotated-key' })
    const updated = await resolveModelConnection('sticky-model', 'opencode')
    assert.equal(state.calls.at(-1)[3], 'native-account')
    assert.equal(updated.apiKey, 'rotated-key')
    state.pinned = true
    await resolveModelConnection('sticky-model', 'opencode')
    assert.equal(state.calls.at(-1)[3], 'account-for-sticky-model')
  } finally { state.pinned = true }
})

test('Claude uses independent compatibility bridge for an OpenAI model, preserving original alias', async () => {
  state.selection = selection()
  const connection = await resolveModelConnection('display-alias', 'claude')
  assert.deepEqual(connection, { baseURL: 'http://127.0.0.1:11435/v1', apiKey: 'internal-only', model: 'display-alias', protocol: 'anthropic', direct: false })
})

test('web accounts and native Ollama protocols use adapters, compatible Ollama routes connect directly', () => {
  assert.equal(directModelConnection(selection({ upstreamKind: undefined }), 'opencode'), null)
  for (const endpoint of ['ollama_chat', 'ollama_generate', 'openai_completion']) {
    assert.equal(directModelConnection(selection({ upstreamKind: 'ollama', ollamaModels: { 'real-model': { endpoint } } }), 'opencode'), null)
  }
  for (const [endpoint, protocol, consumer] of [['openai_chat', 'openai', 'opencode'], ['claude_chat', 'anthropic', 'claude']]) {
    const direct = directModelConnection(selection({ upstreamKind: 'ollama', apiEndpoint: 'http://192.0.2.9:11434', ollamaModels: { 'real-model': { endpoint } } }, { authType: 'none' }), consumer)
    assert.equal(direct.baseURL, 'http://192.0.2.9:11434/v1')
    assert.equal(direct.protocol, protocol)
    assert.equal(direct.direct, true)
  }
})

test('direct Ollama keeps Basic and custom header credentials without forcing JSON accept on streams', () => {
  const provider = { upstreamKind: 'ollama', apiEndpoint: 'http://192.0.2.9:9000', headers: { 'X-Gateway': 'one' }, ollamaModels: { 'real-model': { endpoint: 'openai_chat' } } }
  const basic = directModelConnection(selection(provider, { authType: 'basic', username: 'user', password: 'pw' }), 'opencode')
  assert.deepEqual(basic.headers, { 'x-gateway': 'one', authorization: 'Basic dXNlcjpwdw==' })
  const custom = directModelConnection(selection(provider, { authType: 'api-key', headerName: 'X-Token', headerValue: 'secret' }), 'opencode')
  assert.deepEqual(custom.headers, { 'x-gateway': 'one', 'x-token': 'secret' })
})

test('invalid credentials, URLs and injected header values fail before starting a bridge', async () => {
  const starts = state.bridgeStarts
  for (const bad of [selection({}, {}), selection({ apiEndpoint: 'http://user:password@example.test' }), selection({ headers: { 'x-test': 'bad\r\nInjected: yes' } })]) {
    state.selection = bad
    await assert.rejects(resolveModelConnection('model', 'opencode'))
  }
  state.selection = null
  await assert.rejects(resolveModelConnection('model', 'opencode'), /No available account/)
  await assert.rejects(resolveModelConnection('', 'opencode'), /valid model/)
  assert.equal(state.bridgeStarts, starts)
})

test('Kilo workspace models use the private bridge without selecting an account and reject text-only models', async t => {
  const calls = state.calls.length
  t.mock.method(kiloFreeModels, 'resolve', async id => ({ id, toolCall: true }))
  for (const consumer of ['opencode', 'claude']) {
    const connection = await resolveModelConnection('kilo-free/vendor/model:free', consumer)
    assert.equal(connection.model, 'kilo-free/vendor/model:free')
    assert.equal(connection.baseURL, 'http://127.0.0.1:11435/v1')
    assert.equal(connection.protocol, consumer === 'claude' ? 'anthropic' : 'openai')
    assert.equal(connection.direct, false)
  }
  assert.equal(state.calls.length, calls)
  t.mock.method(kiloFreeModels, 'resolve', async id => ({ id, toolCall: false }))
  await assert.rejects(resolveModelConnection('kilo-free/vendor/model:free', 'opencode'), /tool support/)
})
