import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  OpenCodeFreeModelCatalogue, OPENCODE_FREE_CATALOGUE_TTL, OPENCODE_INFERENCE_BASE_URL, OPENCODE_ZEN_BASE_URL,
  OPENCODE_MODEL_CATALOGUE_URL, parseOpenCodeFreeModels,
  OPENCODE_OPENAI_BASE_URL, OPENCODE_ANTHROPIC_BASE_URL,
} from '../../src/main/companion/opencodeModels.ts'
import { buildOpenCodeConfig } from '../../src/main/companion/opencodeConfig.ts'
import { buildOpenCodeV2Config } from '../../src/main/companion/opencodeV2Config.ts'

const model = (id = 'public-model', overrides: Record<string, unknown> = {}) => ({
  id, name: id, cost: { input: 0, output: 0 }, limit: { context: 128_000, output: 16_000 },
  modalities: { input: ['text'], output: ['text'] }, tool_call: true, ...overrides,
})
const catalog = (models = [model()]) => ({ opencode: { api: OPENCODE_OPENAI_BASE_URL, npm: '@ai-sdk/openai-compatible', models: Object.fromEntries(models.map(item => [item.id, item])) } })
const live = (ids = ['public-model']) => ({ data: ids.map(id => ({ id })) })
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

test('catalogue requires free input/output and all pricing tiers, live membership and text capability', () => {
  const candidates = [
    model('valid'), model('paid-input', { cost: { input: 1, output: 0 } }),
    model('paid-output', { cost: { input: 0, output: 1 } }), model('paid-cache', { cost: { input: 0, output: 0, cache_read: 1 } }),
    model('paid-tier', { cost: { input: 0, output: 0, context_over_200k: { input: 0, output: 2 } } }),
    model('missing-price', { cost: { input: 0 } }), model('string-price', { cost: { input: '0', output: 0 } }),
    model('old', { status: 'deprecated' }), model('missing-live'), model('unsafe/path'),
    model('not-text', { modalities: { input: ['image'], output: ['image'] } }),
    model('redirected', { provider: { api: 'https://other.example/v1' } }),
    model('unknown-sdk', { provider: { npm: 'arbitrary-sdk' } }),
    model('invalid-context', { limit: { context: -1, output: 10 } }),
  ]
  assert.deepEqual(parseOpenCodeFreeModels(catalog(candidates), live(candidates.filter(item => item.id !== 'missing-live').map(item => item.id))).map(item => item.apiModel), ['valid'])
  assert.throws(() => parseOpenCodeFreeModels({ opencode: { ...catalog().opencode, api: 'https://other.example' } }, live()), /格式/)
  assert.throws(() => parseOpenCodeFreeModels(catalog(), { data: {} }), /格式/)
})

test('native catalog preserves SDK protocol and model tool/vision capabilities', () => {
  const candidates = [model(), model('responses', { provider: { npm: '@ai-sdk/openai' }, modalities: { input: ['text', 'image'], output: ['text'] }, reasoning: true, interleaved: { field: 'reasoning_content' } }),
    model('messages', { provider: { npm: '@ai-sdk/anthropic' }, tool_call: false })]
  const parsed = parseOpenCodeFreeModels(catalog(candidates), live(candidates.map(item => item.id)))
  assert.equal(parsed.find(item => item.apiModel === 'public-model')?.protocol, 'chat-completions')
  assert.deepEqual(parsed.find(item => item.apiModel === 'responses'), {
    id: 'opencode-free/responses', apiModel: 'responses', name: 'responses', contextLimit: 128_000, outputLimit: 16_000,
    toolCall: true, vision: true, reasoning: true, temperature: false, interleaved: { field: 'reasoning_content' }, sdk: '@ai-sdk/openai', protocol: 'responses',
  })
  assert.equal(parsed.find(item => item.apiModel === 'messages')?.toolCall, false)
  assert.equal(parsed.find(item => item.apiModel === 'messages')?.protocol, 'messages')
})

test('official catalogue migration accepts protocol-specific routes and legacy bases without allowing other routes', () => {
  const candidates = [model('current', { provider: { api: OPENCODE_OPENAI_BASE_URL } }),
    model('inference', { provider: { api: OPENCODE_INFERENCE_BASE_URL } }),
    model('legacy', { provider: { api: OPENCODE_ZEN_BASE_URL } }),
    model('messages', { provider: { npm: '@ai-sdk/anthropic', api: OPENCODE_ANTHROPIC_BASE_URL } }),
    model('wrong-protocol', { provider: { npm: '@ai-sdk/anthropic', api: OPENCODE_OPENAI_BASE_URL } }),
    model('untrusted', { provider: { api: 'https://opencode.ai.evil.example/inference/v1' } }),
    model('wrong-route', { provider: { api: 'https://opencode.ai/other/v1' } })]
  const listing = live(candidates.map(item => item.id))
  for (const api of [OPENCODE_OPENAI_BASE_URL, OPENCODE_INFERENCE_BASE_URL, OPENCODE_ZEN_BASE_URL]) {
    const catalogue = { opencode: { ...catalog(candidates).opencode, api } }
    assert.deepEqual(parseOpenCodeFreeModels(catalogue, listing).map(item => item.apiModel), ['current', 'inference', 'legacy', 'messages'])
  }
  for (const api of ['https://other.example/inference/v1', OPENCODE_INFERENCE_BASE_URL + '?redirect=other', 'http://opencode.ai/inference/v1',
    OPENCODE_OPENAI_BASE_URL + '/other', OPENCODE_OPENAI_BASE_URL + '?redirect=other', 'https://opencode.ai.evil.example/inference/openai/v1', OPENCODE_ANTHROPIC_BASE_URL]) {
    assert.throws(() => parseOpenCodeFreeModels({ opencode: { ...catalog().opencode, api } }, live()), /格式/)
  }
})

test('native V1 and V2 configs migrate even cached free models to the correct inference protocol', () => {
  const grant = { id: 'qa', name: 'workspace', path: path.resolve('tmp/free-model-config'), writable: true }
  const guard = path.resolve('tmp/free-model-guard')
  const candidates = [model('chat'), model('responses', { provider: { npm: '@ai-sdk/openai' } }), model('messages', { provider: { npm: '@ai-sdk/anthropic' } })]
  const legacy = { opencode: { ...catalog(candidates).opencode, api: OPENCODE_ZEN_BASE_URL } }
  for (const free of parseOpenCodeFreeModels(legacy, live(candidates.map(item => item.id)))) {
    const endpoint = free.protocol === 'messages' ? 'https://opencode.ai/inference/anthropic/v1' : 'https://opencode.ai/inference/openai/v1'
    const v1 = buildOpenCodeConfig([grant], grant, free.id, 'http://unused.local/v1', undefined, free)
    assert.equal(v1.provider.opencode?.models[free.apiModel].provider.api, endpoint)
    const v2 = buildOpenCodeV2Config([grant], grant, free.id, 'http://unused.local/v1', undefined, free, guard)
    assert.equal(v2.providers.opencode.settings.baseURL, endpoint)
    assert.equal(v2.providers.opencode.settings.apiKey, 'public')
    assert.equal(v2.providers.opencode.models[free.apiModel].package, free.protocol === 'messages' ? '@opencode/ai/providers/anthropic'
      : free.protocol === 'responses' ? '@opencode/ai/providers/openai' : '@opencode/ai/providers/openai-compatible')
    assert.deepEqual(v2.model, { providerID: 'opencode', model: free.apiModel })
  }
})

test('refresh coalesces calls, fixes source URLs, retains last good catalogue while failing closed on outage', async () => {
  let now = 1_000_000
  let calls = 0
  let unavailable = false
  const service = new OpenCodeFreeModelCatalogue({ now: () => now, fetch: async (url, options) => {
    calls++
    assert.equal(options?.redirect, 'error')
    assert.ok(options?.signal)
    assert.ok(url === OPENCODE_MODEL_CATALOGUE_URL || url === OPENCODE_INFERENCE_BASE_URL + '/models')
    if (unavailable) throw new Error('internal exception contains a secret that should never reach UI')
    return response(url === OPENCODE_MODEL_CATALOGUE_URL ? catalog() : live())
  } })
  const [first, second] = await Promise.all([service.get(), service.get()])
  assert.equal(calls, 2)
  assert.deepEqual(first, second)
  first.models[0].name = 'changed by caller'
  assert.equal((await service.get()).models[0].name, 'public-model')
  assert.equal((await service.resolve('opencode-free/public-model')).apiModel, 'public-model')
  now += OPENCODE_FREE_CATALOGUE_TTL + 1
  unavailable = true
  const cached = await service.get()
  assert.equal(cached.stale, true)
  assert.equal(cached.models.length, 1)
  assert.doesNotMatch(cached.error!, /secret/)
  await assert.rejects(service.resolve('opencode-free/public-model'), (error: { status: number }) => error.status === 503)
  assert.equal(calls, 4, 'failure cooldown must prevent every poll from retrying')
  unavailable = false
  assert.equal((await service.get(true)).stale, false)
  assert.equal(calls, 6)
})

test('refresh removes paid or delisted models, never falling back to a cached free entry', async () => {
  let paid = false
  const service = new OpenCodeFreeModelCatalogue({ fetch: async url => response(url === OPENCODE_MODEL_CATALOGUE_URL ? catalog([model('public-model', paid ? { cost: { input: 1, output: 0 } } : {})]) : live()) })
  await service.resolve('opencode-free/public-model')
  paid = true
  assert.equal((await service.get(true)).models.length, 0)
  await assert.rejects(service.resolve('opencode-free/public-model'), (error: { status: number }) => error.status === 404)
  await assert.rejects(service.resolve('opencode-free/../../paid'), (error: { status: number }) => error.status === 400)
  await assert.rejects(service.resolve('public-model'), (error: { status: number }) => error.status === 400)
})

test('catalogue persists metadata only, restores fresh cache offline and rejects tampered cache', async () => {
  const directory = await mkdtemp(path.join(path.resolve('tmp'), 'opencode-models-'))
  const cachePath = path.join(directory, 'models.json')
  const fetcher: typeof fetch = async url => response(url === OPENCODE_MODEL_CATALOGUE_URL ? catalog() : live())
  const original = new OpenCodeFreeModelCatalogue({ fetch: fetcher, cachePath, now: () => 1000 })
  await original.get()
  const contents = await readFile(cachePath, 'utf8')
  assert.doesNotMatch(contents, /apiKey|Authorization|messages|credential/)
  let fetched = false
  const offline: typeof fetch = async () => { fetched = true; throw new Error('offline') }
  const restored = new OpenCodeFreeModelCatalogue({ fetch: offline, cachePath, now: () => 2000 })
  assert.equal((await restored.get()).models.length, 1)
  assert.equal(fetched, false)
  const input = JSON.parse(contents)
  await writeFile(cachePath, JSON.stringify({ ...input, models: [{ ...input.models[0], apiModel: '../../paid-model' }] }))
  const invalid = await new OpenCodeFreeModelCatalogue({ fetch: offline, cachePath, now: () => 2000 }).get()
  assert.equal(invalid.models.length, 0)
  assert.equal(invalid.stale, true)
  assert.equal(fetched, true)
})
