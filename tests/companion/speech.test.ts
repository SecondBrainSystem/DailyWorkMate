import test from 'node:test'
import assert from 'node:assert/strict'
import { speechChunks, speechText, summarizeForSpeech, playbackSpeechChunks, clearSpeechSummaryCache } from '../../src/renderer/src/lib/companionSpeech.ts'
import { DEFAULT_COMPANION_SETTINGS, validateSettings } from '../../src/shared/companion.ts'
import type { AppConfig } from '../../src/renderer/src/types/electron'
import { pcmWave } from '../../src/renderer/src/lib/localSpeechAudio.ts'
import { localSpeechSpeaker, LOCAL_SPEECH_VOICES } from '../../src/shared/localSpeech.ts'

test('offline voice defaults migrate legacy system speech and preserve explicit API settings', () => {
  assert.equal(DEFAULT_COMPANION_SETTINGS.ttsMode, 'local')
  assert.equal(DEFAULT_COMPANION_SETTINGS.sttMode, 'local')
  assert.equal(validateSettings({ ...DEFAULT_COMPANION_SETTINGS, ttsMode: 'system' }).ttsMode, 'local')
  assert.equal(validateSettings({ ...DEFAULT_COMPANION_SETTINGS, ttsMode: 'api', tts: { ...DEFAULT_COMPANION_SETTINGS.tts, baseUrl: 'http://127.0.0.1:1234/v1' } }).ttsMode, 'api')
  const legacy = { ...DEFAULT_COMPANION_SETTINGS, sttMode: undefined, stt: { baseUrl: 'http://127.0.0.1:1234/v1', apiKey: '', model: 'whisper' } }
  assert.equal(validateSettings(legacy as never).sttMode, 'api')
  assert.equal(LOCAL_SPEECH_VOICES.length, 103)
  assert.equal(localSpeechSpeaker('auto', 'en', '你好'), 3)
  assert.equal(localSpeechSpeaker('auto', 'en', 'hello'), 0)
  assert.throws(() => localSpeechSpeaker('../../file', 'zh', ''), /Unknown/)
})

test('local microphone PCM is encoded as bounded mono WAV without an external codec', () => {
  const wave = pcmWave(new Float32Array([-2, 0, 2, NaN]), 16000)
  const view = new DataView(wave.buffer)
  assert.equal(new TextDecoder().decode(wave.slice(0, 4)), 'RIFF')
  assert.equal(view.getUint16(22, true), 1)
  assert.equal(view.getInt16(44, true), -32767)
  assert.equal(view.getInt16(48, true), 32767)
  assert.equal(view.getInt16(50, true), 0)
  assert.throws(() => pcmWave(new Float32Array(16000 * 36), 16000), /Invalid/)
})

test('full speech retains the end of long replies, code, punctuation and Unicode', () => {
  const source = '你好🐙。Hello!\n'.repeat(4000) + 'FINAL_SENTENCE'
  for (const limit of [180, 2000]) {
    const chunks = speechChunks(source, limit)
    assert.equal(chunks.join(''), source)
    assert.ok(chunks.every(chunk => chunk.length <= limit && !/[\uD800-\uDBFF]$/.test(chunk)))
  }
  assert.match(speechText('Text\n```js\nconsole.log(1)\n```\nEnd'), /console.log\(1\)[\s\S]*End/)
})

test('existing speech settings migrate and invalid reading controls are rejected', () => {
  const legacy = { ...DEFAULT_COMPANION_SETTINGS, speechVolume: undefined, speechPitch: undefined, readingMode: undefined }
  const settings = validateSettings(legacy as unknown as typeof DEFAULT_COMPANION_SETTINGS)
  assert.equal(settings.readingMode, 'summary')
  assert.equal(settings.speechVolume, 1)
  assert.equal(settings.speechPitch, 1)
  assert.throws(() => validateSettings({ ...settings, speechVolume: -1 }), /volume/)
  assert.throws(() => validateSettings({ ...settings, readingMode: 'invalid' } as never), /reading/)
})

test('spoken summaries cover every segment without changing the original reply', async () => {
  const requests: Array<{ messages: Array<{ content: string }> }> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)))
    assert.equal((init?.headers as Record<string, string>)['X-DailyWorkMate-Model-Selection'], 'explicit')
    const content = 'Key points ' + requests.length
    return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\ndata: [DONE]\n\n')
  }
  try {
    const original = 'Part A. '.repeat(3500) + 'Final important conclusion.'
    const result = await summarizeForSpeech(original, 'qa', { proxyHost: '127.0.0.1', proxyPort: 12, enableApiKey: false } as AppConfig, new AbortController().signal)
    assert.equal(requests.slice(0, -1).map(request => request.messages[1].content).join(''), original)
    assert.match(requests[requests.length - 1].messages[1].content, /Key points 3/)
    assert.equal(result, 'Key points 4')
  } finally { globalThis.fetch = originalFetch }
})


test('short first phrases preserve all Chinese, English, punctuation and Unicode', () => {
  const chinese = '先确认这次修改已经完成，' + '接下来会继续核对模型输出和播放状态'.repeat(16) + '。最后保留完整结论🐙。'
  for (const mode of ['local', 'api', 'system'] as const) {
    const chunks = playbackSpeechChunks(chinese, mode)
    assert.equal(chunks.join(''), chinese)
    assert.equal(chunks[0], '先确认这次修改已经完成，')
    assert.ok([...chunks[0]].length >= 8 && [...chunks[0]].length <= 18)
    assert.ok([...chunks[1]].length > 18)
    assert.ok(chunks.every(chunk => !/[\uD800-\uDBFF]$/.test(chunk)))
  }
  const english = 'The connection is ready, and I will now read every remaining detail carefully. '.repeat(20) + 'FINAL 🐙'
  const spoken = playbackSpeechChunks(english)
  assert.equal(spoken.join(''), english)
  assert.ok([...spoken[0]].length <= 72)
  assert.match(spoken[0], /[,\s.!?]$/)
  assert.equal(playbackSpeechChunks('').length, 0)
})

test('local engine migration preserves an explicitly selected voice and engine', () => {
  const { localEngine: _removed, ...legacy } = DEFAULT_COMPANION_SETTINGS
  assert.equal(validateSettings({ ...legacy, localVoice: 'auto' } as never).localEngine, 'fast')
  assert.equal(validateSettings({ ...legacy, localVoice: 'zf_002' } as never).localEngine, 'kokoro')
  assert.equal(validateSettings({ ...legacy, localVoice: 'zf_002', localEngine: 'fast' } as never).localEngine, 'fast')
  assert.throws(() => validateSettings({ ...legacy, localEngine: 'unknown' } as never), /engine/i)
})

test('completed summaries are reused only for the same reply, model and authenticated proxy', async () => {
  clearSpeechSummaryCache()
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    const content = '结论已经确认，可以继续执行。仍需保留必要的检查步骤。'
    return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\ndata: [DONE]\n\n')
  }
  const config = { proxyHost: '127.0.0.1', proxyPort: 12, enableApiKey: true, apiKeys: [{ key: 'synthetic-account-a', enabled: true }] } as AppConfig
  const source = 'Synthetic source including all caveats. '.repeat(20)
  try {
    const first = await summarizeForSpeech(source, 'cache-model', config, new AbortController().signal)
    assert.equal(await summarizeForSpeech(source, 'cache-model', config, new AbortController().signal), first)
    assert.equal(calls, 1)
    await summarizeForSpeech(source, 'different-model', config, new AbortController().signal)
    await summarizeForSpeech(source, 'cache-model', { ...config, apiKeys: [{ ...config.apiKeys[0], key: 'synthetic-account-b' }] }, new AbortController().signal)
    await summarizeForSpeech(source + 'Changed ending.', 'cache-model', config, new AbortController().signal)
    assert.equal(calls, 4)
  } finally { globalThis.fetch = originalFetch; clearSpeechSummaryCache() }
})

test('only a stable final-summary phrase is offered before completion, without replacing summary semantics', async () => {
  clearSpeechSummaryCache()
  const originalFetch = globalThis.fetch, encoder = new TextEncoder()
  let stream!: ReadableStreamDefaultController<Uint8Array>, offered!: (value: string) => void
  const firstPhrase = new Promise<string>(resolve => { offered = resolve })
  const firstText = '首先确认目前的处理已经完成，接下来还需要核对'
  const rest = '剩余步骤与限制。'
  const event = (content: string) => encoder.encode('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n')
  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; controller.enqueue(event(firstText)) } }))
  try {
    let complete = false
    const task = summarizeForSpeech('Long assistant reply. '.repeat(30), 'stream-model', { proxyHost: '127.0.0.1', proxyPort: 12, enableApiKey: false } as AppConfig, new AbortController().signal, { onFirstChunk: offered }).then(text => { complete = true; return text })
    const prefix = await firstPhrase
    assert.equal(complete, false)
    assert.equal(prefix, playbackSpeechChunks(firstText + rest)[0])
    stream.enqueue(event(rest)); stream.enqueue(encoder.encode('data: [DONE]\n\n')); stream.close()
    assert.equal(await task, firstText + rest)
  } finally { globalThis.fetch = originalFetch; clearSpeechSummaryCache() }
})

test('cancelled summaries cannot be cached or replayed by a later reading', async () => {
  clearSpeechSummaryCache()
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    const content = '首先确认当前任务已经完成，后续还需保留必要的检查步骤。'
    return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\ndata: [DONE]\n\n')
  }
  const config = { proxyHost: '127.0.0.1', proxyPort: 12, enableApiKey: false } as AppConfig
  const controller = new AbortController(), source = 'Abortable reply. '.repeat(30)
  try {
    await assert.rejects(summarizeForSpeech(source, 'abort-model', config, controller.signal, { onFirstChunk: () => controller.abort() }), error => error instanceof DOMException && error.name === 'AbortError')
    await summarizeForSpeech(source, 'abort-model', config, new AbortController().signal)
    assert.equal(calls, 2)
  } finally { globalThis.fetch = originalFetch; clearSpeechSummaryCache() }
})
