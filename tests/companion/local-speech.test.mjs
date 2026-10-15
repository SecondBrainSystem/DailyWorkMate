import test, { before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile, readFile, access } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

let LocalSpeechService, SpeechService, runtime
before(async () => {
  await mkdir(path.resolve('tmp/qa'), { recursive: true })
  runtime = await mkdtemp(path.resolve('tmp/qa/local-speech-test-'))
  const output = path.join(runtime, 'service.mjs')
  await build({ entryPoints: ['src/main/companion/localSpeech.ts'], outfile: output, bundle: true, platform: 'node', format: 'esm', plugins: [{
    name: 'electron-test', setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'test' }))
      builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const app = {isPackaged:false,getAppPath:()=>process.cwd()}' }))
    },
  }] })
  LocalSpeechService = (await import(pathToFileURL(output).href)).LocalSpeechService
  const speechOutput = path.join(runtime, 'speech-service.cjs')
  await build({ entryPoints: ['src/main/companion/speech.ts'], outfile: speechOutput, bundle: true, platform: 'node', format: 'cjs', external: ['axios'], plugins: [{
    name: 'electron-test', setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'test' }))
      builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const app = {isPackaged:false,getAppPath:()=>process.cwd()}' }))
    },
  }] })
  SpeechService = (await import(pathToFileURL(speechOutput).href)).default.SpeechService
  for (const directory of ['models/tts', 'models/stt', 'models/fast/espeak-ng-data', 'node_modules/sherpa-onnx-node']) await mkdir(path.join(runtime, directory), { recursive: true })
  for (const file of ['models/tts/model.onnx', 'models/tts/voices.bin', 'models/stt/model.onnx', 'models/stt/tokens.txt', 'models/fast/model.onnx', 'models/fast/vocoder.onnx', 'models/fast/tokens.txt', 'models/fast/lexicon.txt', 'node_modules/sherpa-onnx-node/package.json']) await writeFile(path.join(runtime, file), '')
  await writeFile(path.join(runtime, 'runtime-manifest.json'), JSON.stringify({ engine: 'sherpa-onnx', platform: process.platform, arch: process.arch, directory: 'models/tts', file: 'model.onnx', recognition: { directory: 'models/stt', file: 'model.onnx' }, fast: { family: 'matcha', directory: 'models/fast', file: 'model.onnx', vocoder: 'vocoder.onnx' } }))
  await writeFile(path.join(runtime, 'local-speech-worker.cjs'), `let generated=0,warmups=0;process.on('message',m=>{
    if(m.text==='hang')return;
    if(m.text==='crash'){process.exit(2);return}
    if(m.text==='bad'){process.send({id:m.id,audio:Buffer.alloc(2)});return}
    if(m.text==='fast-bad'&&m.engine==='fast'){process.send({id:m.id,error:'fast model unavailable'});return}
    if(m.operation==='warmup'){warmups++;setTimeout(()=>process.send({id:m.id,warmed:true}),30);return}
    if(m.operation==='transcribe'){process.send({id:m.id,text:'offline recognition'});return}
    const audio=Buffer.alloc(48);audio.writeUInt32LE(process.pid,0);audio.writeUInt32LE(++generated,4);audio.writeUInt32LE(warmups,8);audio.writeUInt32LE(m.engine==='fast'?1:0,12);
    process.send({id:m.id,audio});
  });process.on('disconnect',()=>process.exit());`)
})
const create = (options = {}) => new LocalSpeechService({ runtimeDirectory: runtime, execPath: process.execPath, timeout: 2000, ...options })
const synthesize = (service, text = 'hello', signal) => service.synthesize(text, 'auto', 'en-US', 1, signal)

test('local status checks synthesis and recognition resources; no API is needed', async () => {
  const service = create()
  try {
    const status = await service.status()
    assert.equal(status.available, true); assert.equal(status.recognitionAvailable, true)
    assert.equal((await synthesize(service)).mime, 'audio/wav')
    assert.equal(await service.transcribe(new Uint8Array(48)), 'offline recognition')
    await assert.rejects(service.synthesize('hello', 'invalid', 'en', 1), /Unknown local/)
    await assert.rejects(service.synthesize('hello', 'auto', 'en', 3), /rate/)
    await assert.rejects(synthesize(service, 'x'.repeat(2001)), /2000/)
  } finally { service.dispose() }
})

test('cancel kills pending generation and the next request starts a fresh worker', async () => {
  const service = create()
  try {
    const pending = synthesize(service, 'hang')
    const rejected = assert.rejects(pending, /cancelled/)
    await new Promise(resolve => setTimeout(resolve, 80)); service.cancel(); await rejected
    assert.equal((await synthesize(service)).audio.byteLength, 48)
  } finally { service.dispose() }
})

test('AbortSignal cancellation and worker crashes recover on the following request', async () => {
  const service = create()
  try {
    const controller = new AbortController()
    const pending = synthesize(service, 'hang', controller.signal)
    const rejected = assert.rejects(pending, /cancelled/)
    controller.abort(); await rejected
    await assert.rejects(synthesize(service, 'crash'), /exited/)
    await assert.rejects(synthesize(service, 'bad'), /invalid audio/)
    assert.equal((await synthesize(service)).audio.byteLength, 48)
  } finally { service.dispose() }
})

test('timeouts terminate computation and missing runtime reports an actionable state', async () => {
  // Long enough for a fresh worker to start under full-suite load; the hung job still has to be killed.
  const service = create({ timeout: 1500 })
  try {
    await assert.rejects(synthesize(service, 'hang'), /timed out/)
    assert.equal((await synthesize(service)).mime, 'audio/wav')
    const missing = new LocalSpeechService({ runtimeDirectory: path.join(runtime, 'missing') })
    assert.equal((await missing.status()).available, false)
    await assert.rejects(synthesize(missing), /resources are missing/)
  } finally { service.dispose() }
})

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const info = result => { const bytes = Buffer.from(result.audio); return { pid: bytes.readUInt32LE(0), generated: bytes.readUInt32LE(4), warmups: bytes.readUInt32LE(8), fast: bytes.readUInt32LE(12) } }

test('preloading is deduplicated and idle cancellation preserves the warm model', async () => {
  const service = create()
  try {
    const pending = service.warmup('auto', 'zh-CN', 1, 'fast')
    const duplicate = service.warmup('auto', 'zh-CN', 1, 'fast')
    service.cancel()
    const statuses = await Promise.all([pending, duplicate])
    assert.equal(statuses[0].ready, true); assert.equal(statuses[1].readyEngine, 'fast')
    const first = info(await service.synthesize('first', 'auto', 'zh-CN', 1, undefined, 'fast'))
    assert.equal(first.warmups, 1)
    service.cancel(); service.cancel()
    await service.warmup('auto', 'zh-CN', 1, 'fast')
    const second = info(await service.synthesize('second', 'auto', 'zh-CN', 1, undefined, 'fast'))
    assert.equal(second.pid, first.pid); assert.equal(second.warmups, 1)
    assert.equal((await service.status()).ready, true)
  } finally { service.dispose() }
})

test('active cancellation rejects promptly and starts a fresh warm worker in the background', async () => {
  const service = create({ rewarmDelay: 20 })
  try {
    const first = info(await synthesize(service, 'before'))
    const pending = synthesize(service, 'hang')
    const rejected = assert.rejects(pending, /cancelled/)
    await delay(60); service.cancel(); await rejected
    for (let attempt = 0; attempt < 40 && !(await service.status()).ready; attempt++) await delay(25)
    assert.equal((await service.status()).ready, true)
    const after = info(await synthesize(service, 'after'))
    assert.notEqual(after.pid, first.pid); assert.equal(after.warmups, 1)
  } finally { service.dispose() }
})

test('private audio cache clones bytes and separates voice, speed, engine and model identity', async () => {
  const service = create()
  const manifestPath = path.join(runtime, 'runtime-manifest.json')
  const original = await readFile(manifestPath, 'utf8')
  try {
    const first = await synthesize(service)
    const expected = new Uint8Array(first.audio)
    first.audio.fill(255)
    assert.deepEqual((await synthesize(service)).audio, expected)
    assert.equal(info(await service.synthesize('hello', 'af_sol', 'en-US', 1)).generated, 2)
    assert.equal(info(await service.synthesize('hello', 'auto', 'en-US', 1.1)).generated, 3)
    const fast = info(await service.synthesize('hello', 'auto', 'en-US', 1, undefined, 'fast'))
    assert.equal(fast.generated, 4); assert.equal(fast.fast, 1)
    const firstPid = fast.pid
    await writeFile(manifestPath, JSON.stringify({ ...JSON.parse(original), revision: 'new-model' }))
    assert.notEqual(info(await synthesize(service)).pid, firstPid)
  } finally { service.dispose(); await writeFile(manifestPath, original) }
})

test('audio cache obeys byte limits, LRU ordering, expiration and disposal', async () => {
  const service = create({ cacheBytes: 96, cacheEntries: 2, cacheTtl: 150 })
  try {
    await synthesize(service, 'one'); await synthesize(service, 'two')
    assert.equal(info(await synthesize(service, 'one')).generated, 1)
    await synthesize(service, 'three')
    assert.equal(info(await synthesize(service, 'two')).generated, 4)
    await delay(180)
    assert.equal(info(await synthesize(service, 'two')).generated, 5)
    service.dispose()
    await assert.rejects(synthesize(service, 'two'), /closed/)
    await assert.rejects(service.warmup(), /closed/)
    assert.equal((await service.status()).ready, false)
  } finally { service.dispose() }
})

test('idle expiry releases a warm worker and later preloading can restart it', async () => {
  const service = create({ idleTimeout: 80 })
  try {
    const first = info(await synthesize(service))
    await delay(140)
    assert.equal((await service.status()).ready, false)
    await service.warmup('auto', 'en-US')
    const next = info(await synthesize(service, 'new'))
    assert.notEqual(next.pid, first.pid); assert.equal(next.warmups, 1)
  } finally { service.dispose() }
})

test('SpeechService fast fallback is explicit and cancellation never falls through to Kokoro', async () => {
  const service = new SpeechService({ runtimeDirectory: runtime, execPath: process.execPath, timeout: 2000 })
  const settings = { ttsMode: 'local', localEngine: 'fast', localVoice: 'auto', language: 'en-US', speechRate: 1 }
  try {
    assert.equal((await service.warmup(settings)).readyEngine, 'fast')
    assert.equal(info(await service.synthesize(settings, 'hello')).fast, 1)
    const pending = service.synthesize(settings, 'hang')
    const rejected = assert.rejects(pending, /cancelled/)
    await delay(80); service.cancel(); await rejected
    const fallback = await service.synthesize(settings, 'fast-bad')
    assert.equal(info(fallback).fast, 0); assert.match(fallback.notice, /Fast voice is unavailable/)
    const following = await service.synthesize(settings, 'next fallback')
    assert.equal(info(following).fast, 0); assert.match(following.notice, /fast model unavailable/)
    await assert.rejects(service.synthesize(settings, 'x'.repeat(2001)), /2000/)
  } finally { service.dispose() }
})

test('unsafe fast model paths are rejected while Kokoro remains available', async () => {
  const service = create()
  const manifestPath = path.join(runtime, 'runtime-manifest.json')
  const original = await readFile(manifestPath, 'utf8')
  try {
    const parsed = JSON.parse(original)
    await writeFile(manifestPath, JSON.stringify({ ...parsed, fast: { ...parsed.fast, directory: '../outside' } }))
    const status = await service.status()
    assert.equal(status.available, true); assert.equal(status.fastAvailable, false)
    await assert.rejects(service.synthesize('hello', 'auto', 'en-US', 1, undefined, 'fast'), /Invalid local voice model path/)
    assert.equal((await synthesize(service)).mime, 'audio/wav')
  } finally { service.dispose(); await writeFile(manifestPath, original) }
})

test('cancelling user work during preloading never starts the fallback engine', async () => {
  const directory = await mkdtemp(path.join(runtime, 'cancel-race-'))
  const marker = path.join(directory, 'user-request-received')
  const workerPath = path.join(directory, 'worker.cjs')
  await writeFile(workerPath, `process.on('message',m=>{if(m.operation==='warmup')setTimeout(()=>process.send({id:m.id,warmed:true}),300);else require('node:fs').writeFileSync(${JSON.stringify(marker)},'ready')});process.on('disconnect',()=>process.exit())`)
  const service = new SpeechService({ runtimeDirectory: runtime, workerPath, execPath: process.execPath, timeout: 2000, rewarmDelay: 500 })
  const settings = { ttsMode: 'local', localEngine: 'fast', localVoice: 'auto', language: 'en-US', speechRate: 1 }
  try {
    const warming = service.warmup(settings)
    const pending = service.synthesize(settings, 'hang')
    const rejected = assert.rejects(pending, /cancelled/)
    for (let i = 0; i < 40; i++) { try { await access(marker); break } catch { await delay(10) } }
    await access(marker)
    service.cancel(); await rejected
    const state = await warming
    assert.match(state.error, /cancelled/)
    assert.equal(state.ready, false); assert.notEqual(state.readyEngine, 'kokoro')
    await delay(100)
    assert.equal((await service.localStatus()).warming, false)
    const ready = await service.warmup(settings)
    assert.equal(ready.readyEngine, 'fast')
  } finally { service.dispose() }
})
