// Integration check: actual SpeechService, native child, real models and no HTTP speech service.
const fs = require('node:fs/promises')
const path = require('node:path')
const assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')
const { build } = require('esbuild')
const runtime = path.resolve(process.argv.find(value => value.startsWith('--runtime='))?.slice(10) || 'companion/runtime/speech')
const output = path.resolve('tmp/qa/fast-speech-service-' + Date.now())
const results = []
async function timed(label, operation) {
  const began = performance.now()
  const value = await operation()
  const ms = Math.round((performance.now() - began) * 100) / 100
  const record = { label, ms, ...(value?.audio ? { bytes: value.audio.length, mime: value.mime, notice: value.notice } : { status: value }) }
  results.push(record); console.log(JSON.stringify(record))
  return { value, ms }
}
function assertWave(result, rate) {
  assert.equal(result.mime, 'audio/wav')
  const bytes = Buffer.from(result.audio)
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF')
  assert.equal(bytes.readUInt32LE(24), rate)
  assert.ok(bytes.length > rate)
}
async function main() {
  await fs.mkdir(output, { recursive: true })
  const bundled = path.join(output, 'speech-service.mjs')
  await build({ stdin: { contents: `export {SpeechService} from './src/main/companion/speech.ts'; export {DEFAULT_COMPANION_SETTINGS} from './src/shared/companion.ts';`, resolveDir: path.resolve('.') }, outfile: bundled,
    bundle: true, platform: 'node', format: 'esm', packages: 'external', plugins: [{ name: 'isolated-electron-and-network', setup(builder) {
      builder.onResolve({ filter: /^(?:electron|axios)$/ }, args => ({ path: args.path, namespace: 'qa' }))
      builder.onLoad({ filter: /.*/, namespace: 'qa' }, args => ({ contents: args.path === 'electron'
        ? 'export const app={isPackaged:false,getAppPath:()=>process.cwd()}'
        : `export default {post(){throw new Error('Unexpected speech HTTP request')},isAxiosError(){return false}}` }))
    } }] })
  const { SpeechService, DEFAULT_COMPANION_SETTINGS } = await import(pathToFileURL(bundled).href)
  const settings = { ...DEFAULT_COMPANION_SETTINGS, ttsMode: 'local', localEngine: 'fast', localVoice: 'auto', speechRate: 1, language: 'zh-CN' }
  const service = new SpeechService({ runtimeDirectory: runtime })
  try {
    const status = await timed('resource-status', () => service.localStatus())
    assert.equal(status.value.fastAvailable, true)
    const warm = await timed('warmup-fast', () => service.warmup(settings))
    assert.equal(warm.value.ready, true); assert.equal(warm.value.readyEngine, 'fast')
    const first = await timed('first-new-text-after-warmup', () => service.synthesize(settings, '欢迎回来，我一直都在。'))
    assertWave(first.value, 16000); assert.equal(first.value.notice, undefined)
    const repeated = await timed('repeat-text-from-memory', () => service.synthesize(settings, '欢迎回来，我一直都在。'))
    assert.deepEqual(repeated.value.audio, first.value.audio)
    assert.ok(repeated.ms < first.ms, 'A cached request should be faster than native generation')
    service.cancel()
    const afterStop = await timed('status-after-idle-stop', () => service.localStatus())
    assert.equal(afterStop.value.readyEngine, 'fast'); assert.equal(afterStop.value.ready, true)
    const novel = await timed('new-text-after-idle-stop', () => service.synthesize(settings, '让我们开始新的工作吧。'))
    assertWave(novel.value, 16000)
    assert.ok(novel.ms < 1500, 'An idle stop must not force the seven-second model initialization again')
    await fs.writeFile(path.join(output, 'fast-service.wav'), first.value.audio)
  } finally { service.dispose() }

  // A corrupt acoustic model exists only in this disposable QA runtime. Real resources are untouched.
  const scratch = path.join(output, 'fault-runtime')
  await fs.mkdir(scratch)
  for (const name of ['models', 'node_modules', 'bin']) await fs.symlink(path.join(runtime, name), path.join(scratch, name), process.platform === 'win32' ? 'junction' : 'dir')
  await fs.copyFile(path.join(runtime, 'local-speech-worker.cjs'), path.join(scratch, 'local-speech-worker.cjs'))
  const original = JSON.parse(await fs.readFile(path.join(runtime, 'runtime-manifest.json'), 'utf8'))
  const broken = path.join(scratch, 'broken-fast')
  await fs.mkdir(broken)
  await fs.writeFile(path.join(broken, 'broken.onnx'), 'synthetic invalid model for fallback testing')
  const actualFast = path.join(runtime, original.fast.directory)
  for (const file of [original.fast.vocoder, 'tokens.txt', 'lexicon.txt']) await fs.link(path.join(actualFast, file), path.join(broken, file))
  await fs.symlink(path.join(actualFast, 'espeak-ng-data'), path.join(broken, 'espeak-ng-data'), process.platform === 'win32' ? 'junction' : 'dir')
  await fs.writeFile(path.join(scratch, 'runtime-manifest.json'), JSON.stringify({ ...original, fast: { ...original.fast, directory: 'broken-fast', file: 'broken.onnx' } }))
  const fallback = new SpeechService({ runtimeDirectory: scratch })
  try {
    const result = await timed('real-fast-model-failure-to-kokoro', () => fallback.synthesize(settings, '你好，我在这里。'))
    assertWave(result.value, 24000)
    assert.match(result.value.notice || '', /快速语音暂不可用/)
    await fs.writeFile(path.join(output, 'fallback-kokoro.wav'), result.value.audio)
  } finally { fallback.dispose() }
}
main().then(() => fs.writeFile(path.join(output, 'evidence.json'), JSON.stringify({ passed: true, runtime, results }, null, 2)))
  .then(() => console.log('PASS ' + path.join(output, 'evidence.json')))
  .catch(async error => { console.error(error); process.exitCode = 1; await fs.mkdir(output, { recursive: true }); await fs.writeFile(path.join(output, 'evidence.json'), JSON.stringify({ passed: false, runtime, results, error: error.message }, null, 2)) })
