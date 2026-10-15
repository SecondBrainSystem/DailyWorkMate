import test from 'node:test'
import assert from 'node:assert/strict'
import { API_PRESETS, chatModelIds } from '../../src/shared/apiProviders.ts'
import { ApiKeyRejected, addApiProvider, listApiModels, refreshApiModels, resolveApiTarget, type ApiProviderStore } from '../../src/main/providers/apiProviders.ts'
import { anthropicApiBody, anthropicMessagesUrl } from '../../src/main/proxy/adapters/anthropicApi.ts'
import type { Provider } from '../../src/main/store/types.ts'

test('only chat models are offered from vendor model lists', () => {
  assert.deepEqual(chatModelIds(['gpt-5', 'text-embedding-3-large', 'whisper-1', 'gpt-image-1', 'o3-pro', 'gpt-4o-realtime-preview', 'models/gemini-2.5-pro', 'gemini-embedding-001', 'qwen-max', 'paraformer-v2', 'gpt-5', '', 42]),
    ['gemini-2.5-pro', 'gpt-5', 'qwen-max'])
})

test('presets resolve to their official address; regions and custom addresses are honoured', () => {
  assert.equal(resolveApiTarget({ presetId: 'openai' }).baseUrl, 'https://api.openai.com/v1')
  assert.equal(resolveApiTarget({ presetId: 'moonshot', regionId: 'intl' }).baseUrl, 'https://api.moonshot.ai/v1')
  assert.equal(resolveApiTarget({ presetId: 'zhipu', regionId: 'missing' }).baseUrl, 'https://open.bigmodel.cn/api/paas/v4')
  assert.equal(resolveApiTarget({ presetId: 'openai-compatible', baseUrl: ' http://127.0.0.1:8000/v1/ ' }).baseUrl, 'http://127.0.0.1:8000/v1')
  assert.throws(() => resolveApiTarget({ presetId: 'openai-compatible' }), /API address/)
  assert.throws(() => resolveApiTarget({ presetId: 'openai-compatible', baseUrl: 'ftp://x' }), /https/)
  assert.throws(() => resolveApiTarget({ presetId: 'nope' }), /Unknown/)
  for (const preset of API_PRESETS.filter(item => item.regions.length)) for (const region of preset.regions) assert.match(region.baseUrl, /^https:\/\//)
})

test('model lists use each vendor\'s own endpoint and auth; a refused key is reported as such', async () => {
  const calls: Array<{ url: string; config: any }> = []
  const reply = (status: number, data: unknown) => async (url: string, config: any) => { calls.push({ url, config }); return { status, data } as any }
  assert.deepEqual(await listApiModels('openai', 'https://api.openai.com/v1', 'sk-1', reply(200, { data: [{ id: 'gpt-5' }, { id: 'tts-1' }] })), ['gpt-5'])
  assert.equal(calls.at(-1)!.url, 'https://api.openai.com/v1/models')
  assert.equal(calls.at(-1)!.config.headers.Authorization, 'Bearer sk-1')
  assert.deepEqual(await listApiModels('anthropic', 'https://api.anthropic.com', 'sk-ant', reply(200, { data: [{ id: 'claude-sonnet-4-5' }] })), ['claude-sonnet-4-5'])
  assert.equal(calls.at(-1)!.url, 'https://api.anthropic.com/v1/models')
  assert.deepEqual([calls.at(-1)!.config.headers['x-api-key'], calls.at(-1)!.config.headers['anthropic-version']], ['sk-ant', '2023-06-01'])
  const gemini = await listApiModels('gemini', 'https://generativelanguage.googleapis.com/v1beta/openai', 'AIza', reply(200, { models: [
    { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
  ] }))
  assert.deepEqual(gemini, ['gemini-2.5-pro'])
  assert.equal(calls.at(-1)!.url, 'https://generativelanguage.googleapis.com/v1beta/models')
  assert.equal(calls.at(-1)!.config.headers['x-goog-api-key'], 'AIza')
  await assert.rejects(listApiModels('openai', 'https://x/v1', 'bad', reply(401, { error: { message: 'Incorrect API key' } })), (error: Error) => error instanceof ApiKeyRejected && /Incorrect API key/.test(error.message))
  await assert.rejects(listApiModels('openai', 'https://x/v1', 'k', reply(500, 'down')), /HTTP 500/)
  await assert.rejects(listApiModels('gemini', 'https://generativelanguage.googleapis.com/v1beta/openai', 'bad', reply(400, { error: { message: 'API key not valid. Please pass a valid API key.' } })), ApiKeyRejected)
  await assert.rejects(listApiModels('openai', 'https://x/v1', 'k', reply(400, { error: { message: 'unsupported parameter' } })), (error: Error) => !(error instanceof ApiKeyRejected) && /HTTP 400/.test(error.message))
  await assert.rejects(listApiModels('openai', 'https://x/v1', 'k', reply(200, { data: [{ id: 'text-embedding-3-small' }] })), /no chat models/)
})

function memoryStore(otherModels: string[] = []) {
  const providers = new Map<string, Provider>()
  const keys = new Map<string, string[]>()
  const store: ApiProviderStore = {
    getProvider: id => providers.get(id),
    addProvider: provider => { providers.set(provider.id, provider) },
    updateProvider: (id, updates) => { providers.set(id, { ...providers.get(id)!, ...updates }) },
    keys: id => keys.get(id) || [],
    addKey: (id, _name, key) => { keys.set(id, [...(keys.get(id) || []), key]); return 'account-' + keys.get(id)!.length },
    otherModels: () => new Set(otherModels),
  }
  return { store, providers, keys }
}

test('the first key creates the provider; more keys become accounts of the same provider', async () => {
  const { store, providers, keys } = memoryStore(['deepseek-chat'])
  const list = async (_kind: string, _base: string, key: string) => key === 'sk-two' ? ['deepseek-chat', 'deepseek-v5'] : ['deepseek-chat', 'deepseek-reasoner']
  const first = await addApiProvider({ presetId: 'deepseek', apiKey: ' sk-one ' }, store, list as any)
  assert.deepEqual(first, { providerId: 'api-deepseek', accountId: 'account-1', models: ['deepseek-chat', 'deepseek-reasoner'], addedKey: false, sharedModels: ['deepseek-chat'] })
  const provider = providers.get('api-deepseek')!
  assert.deepEqual([provider.type, provider.upstreamKind, provider.apiPreset, provider.apiProtocol, provider.apiEndpoint, provider.chatPath], ['custom', 'api', 'deepseek', 'openai', 'https://api.deepseek.com', '/chat/completions'])
  assert.equal(provider.credentialFields?.[0].name, 'apiKey')
  const second = await addApiProvider({ presetId: 'deepseek', apiKey: 'sk-two' }, store, list as any)
  assert.equal(second.addedKey, true)
  assert.deepEqual(providers.get('api-deepseek')!.supportedModels, ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v5'])
  assert.deepEqual(keys.get('api-deepseek'), ['sk-one', 'sk-two'])
  await assert.rejects(addApiProvider({ presetId: 'deepseek', apiKey: 'sk-two' }, store, list as any), /already been added/)
  await assert.rejects(addApiProvider({ presetId: 'deepseek', apiKey: 'sk-three', baseUrl: 'https://proxy.example/v1' }, store, list as any), /already set up/)
  await assert.rejects(addApiProvider({ presetId: 'deepseek', apiKey: 'has space' }, store, list as any), /valid API key/)

  const claude = await addApiProvider({ presetId: 'anthropic', apiKey: 'sk-ant-1' }, store, (async () => ['claude-sonnet-4-5']) as any)
  assert.equal(providers.get(claude.providerId)!.apiProtocol, 'anthropic')
  const custom = await addApiProvider({ presetId: 'openai-compatible', apiKey: 'k', baseUrl: 'http://127.0.0.1:8000/v1', name: 'Local vLLM' }, store, (async () => ['qwen3']) as any)
  assert.match(custom.providerId, /^api-custom-[0-9a-f]{12}$/)
  assert.equal(providers.get(custom.providerId)!.name, 'Local vLLM')

  assert.deepEqual(await refreshApiModels('api-deepseek', store, (async () => ['deepseek-v6']) as any), ['deepseek-v6'])
  assert.deepEqual(providers.get('api-deepseek')!.modelMappings, { 'deepseek-v6': 'deepseek-v6' })
})

test('Claude API requests carry a usable max_tokens and never both temperature and top_p', () => {
  const body = anthropicApiBody({ model: 'm', messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }], temperature: 0.2, top_p: 1 }, 'claude-sonnet-4-5')
  assert.equal(body.max_tokens, 8192)
  assert.equal(body.temperature, 0.2)
  assert.equal('top_p' in body, false)
  assert.equal(body.system, 'be brief')
  assert.equal(anthropicApiBody({ model: 'm', messages: [{ role: 'user', content: 'hi' }], max_tokens: 100, top_p: 0.9 }, 'm').top_p, 0.9)
  assert.equal(anthropicMessagesUrl('https://api.anthropic.com'), 'https://api.anthropic.com/v1/messages')
  assert.equal(anthropicMessagesUrl('https://gateway.example/v1/'), 'https://gateway.example/v1/messages')
})
